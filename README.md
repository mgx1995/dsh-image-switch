# dsh-image-switch

Switch which backend `generate_image` uses — local Stable Diffusion, Volcengine Ark (Doubao Seedream), AutoDL.Art, async video models such as SCNet MiniMax-H3, or any OpenAI-compatible image API — from a Settings page, with a key per backend.

## What it does

DeepSeek Harness resolves `generate_image` from the provider rows in the profile, so changing the image model normally means hand-editing `cordis.patch.yml`. This bundle puts a **Settings → Image routing** page in front of that: every backend is a card, and the one you mark as default is pushed into `dsh-model-think-level`, so later `generate_image` calls need no `model` argument.

## Install

```sh
# from the workspace that contains this directory
plugin_manager install_bundle /absolute/path/to/dsh-image-switch
```

Restart nothing: opening and re-enabling the bundle in **Settings → Plugins** is enough to pick up new Host-side code.

## Backends that ship with it

| name | kind | upstream | model |
| --- | --- | --- | --- |
| `doubao` | ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seedream-4-0-20260415` |
| `autodl` | openai | `https://www.autodl.art/api/v1` | `doubao-seedream-5-0-flash` |
| `autodlz` | openai | `https://www.autodl.art/api/v1` | `Z-Image-Turbo` |
| `supooo` | openai | `https://www.supooo.com/v1` | `supooo.image` |
| `scnet` | video | `https://api.scnet.cn/api/llm/v1` | `MiniMax-H3` |
| `local` | openai | `http://127.0.0.1:17890/v1` | `sd1.5` |
| `local-base` | openai | `http://127.0.0.1:17890/v1` | `sd15-base` |

Models are addressed as `img-router/<backend name>`.

## Why a local middle layer

Upstream image APIs disagree on their request shape, and the caller is fixed:

- Volcengine Ark has **no `quality` parameter** and accepts only `1K` / `1.5K` / `2K` / `auto` or a pixel size inside `[921600, 4624220]`.
- AutoDL.Art wants a **bare token** (`Authorization: <key>`, no `Bearer`) and also rejects `quality`.
- Ark watermarks by default and answers with a **URL**, sometimes a JPEG.
- Video models answer with a **task id**, not an image, and their result arrives minutes later.

So every request is normalized here: `quality` is dropped for backends that declare `stripQuality`, `n > 1` becomes several requests, `size` is mapped into the range the upstream accepts, `watermark: false` is sent to Ark, and any returned URL is downloaded and converted to PNG bytes (via ffmpeg or Pillow) because the caller declares `image/png` unconditionally.

## Video backends

`kind: "video"` is for asynchronous text-to-video APIs. The caller still asks for an image, so one request becomes:

1. `POST {baseURL}/videos/generations` with `X-MultiModal-Async: true`, body `{model, input:{prompt}, parameters:{resolution, duration, ratio, watermark}}`
2. `GET {baseURL}/tasks/{task_id}` until a video URL shows up — status words are normalized (`succeed` / `processing` / `failed` in whatever spelling), and the task id and `.mp4` URL are dug out of the response recursively rather than from one hard-coded path
3. download the mp4 and keep it in `~/.dsh/image-switch/videos/scnet-<task_id>.mp4`
4. grab evenly spaced frames with ffmpeg and return them as PNG `b64_json`

Per-backend video fields: `videoResolution` (`768P`), `videoDuration` (seconds), `videoRatio` (`16:9`), `videoFrames` (1-6, how many stills to return), `videoPollMs`, `videoTimeoutMs`.

Testing a video backend only checks the key and endpoint. A real clip takes minutes and spends daily quota, so **Test** does not fire one; use `generate_image` when you actually want a clip.

## Adding your own backend

**Settings → Image routing → ＋ Add backend**, then fill in:

| field | meaning |
| --- | --- |
| name | the id you will type after `img-router/`, letters/digits/`_`/`-` only |
| base URL | the service root that answers `/images/generations` (or `/videos/generations`), e.g. `https://api.example.com/v1` |
| model | the upstream model id |
| protocol | `OpenAI compatible`, `Volcengine Ark`, or `Video (async task)` |
| auth prefix | `Bearer ` (default) or empty for services that want the bare token |
| strip quality | on when the upstream rejects a `quality` field |
| watermark | on to send `watermark: false` (Ark defaults to a visible watermark) |
| key | optional; leave blank to fall back to `apiKeyEnv` or `.credentials.yaml` |

Saving a backend also writes its row into the profile's `img-router` provider, so the model shows up on the **Models** page immediately. Deleting a backend removes that row again — the built-in ones included (their names go into `removed` in `config.json`, so they stay gone; re-adding a backend of the same name clears that entry). If the profile is busy the row write is retried; a `list / remove / add / sync` call through the `image_router` tool reports the same result. The **Sync to Models page** button on the panel re-runs that reconciliation by hand.

Delete removes on the first click and the header then offers **Undo**, which writes the full backend definition back.

## Configuration

- `~/.dsh/image-switch/config.json` — backend definitions and the active backend. Hand-editable; the page reloads it.
- `~/.dsh/image-switch/keys.json` — per-backend keys, written with mode `600`.
- `~/.dsh/image-switch/videos/` — mp4 files downloaded from video backends, named `<backend>-<task_id>.mp4`.

The provider rows under `providers['img-router']` in the profile's `cordis.patch.yml` are **generated** from `config.json`: the panel writes them through the profile's `configEditor` service, and only rows carrying `inputImageGen: true` belong to this bundle — rows you added by hand are left alone.

Key resolution order per backend: the key saved from this panel → `apiKey` in the backend definition → `process.env[apiKeyEnv]` → the `refs` section of `~/.dsh/.credentials.yaml`.

On first run it imports an existing `~/.dsh/image-router/config.json` or the older `image-shim/shim.json`, so an earlier install keeps its keys.

## Networking note

HTTP calls go through `node:http`/`node:https` with `family: 4` instead of the global `fetch`. Node's Happy Eyeballs (`autoSelectFamily`) picks an IPv6 address first on some networks where IPv6 resolves but does not route, and the request then sits until `UND_ERR_CONNECT_TIMEOUT` even though `curl` and `node:https` reach the same host fine. `api.scnet.cn` behaves exactly like that. Multipart uploads (image edits) still use `fetch`, because only it encodes `FormData`.

## Agent tool

`image_router` — `list` / `use` / `set_key` / `test` / `add` / `remove` / `sync`, the same implementation the Settings page calls. `add` and `remove` also report which model rows they added or removed on the Models page.

## Standalone endpoint

The bundle also listens on `127.0.0.1:17891` with an OpenAI-compatible `/v1/images/generations` and `/v1/images/edits`, because a provider `baseURL` has to be a fixed address — the DSH web port moves between launches. If 17891 is taken, the Settings page still works and generation through it keeps working; only the standalone listener is skipped.

`GET /health`, `GET /state`, `GET /v1/models`, `POST /admin/default`, `POST /admin/key`, `POST /admin/test` are available there too.

## License

MIT
