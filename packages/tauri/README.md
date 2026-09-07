# reticle-tauri

Screenshots and headless mode for a Tauri app running under [Reticle](https://reticle.sh).

Everything else Reticle does on Tauri — snapshot, act, assert, state, IPC, console, network — needs nothing from this crate. The SDK connects to the daemon from inside the webview on its own. This crate exists for the two things only the Rust side can do.

## Use

```toml
[dependencies]
reticle-tauri = "0.1"
```

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![reticle_tauri::reticle_capture])
    .on_page_load(reticle_tauri::on_page_load)
```

Nothing on the JavaScript side. Tauri has no preload stage where a shim could be installed, so the SDK invokes `reticle_capture` through Tauri's own internals when it needs pixels.

### Screenshots

`reticle_capture` writes a PNG to the OS temp directory and returns its path; `reticle_screenshot` and `reticle_visual_diff` work from there. Each platform uses its own webview API:

| Platform | API | Status |
| --- | --- | --- |
| macOS | `WKWebView.takeSnapshot` | Verified against a running app |
| Linux, BSD | WebKitGTK `webkit_web_view_get_snapshot` | Snapshot + PNG encoding verified under `xvfb`; not yet driven through a full Tauri app |
| Windows | WebView2 `CapturePreview` | **Untested — compiles, never executed** |

The Windows path is written and type-checked against the real `webview2-com` API (which caught two genuine type errors), but nobody has run it on Windows. It is shipped rather than withheld so it can be tried, and labelled rather than listed flatly so that trying it is a choice. If it works for you, say so and this row changes; treat a green from it as unconfirmed until then.

It renders the webview, not the screen. Capturing a screen region instead would photograph whatever is on top — an app window behind your editor yields a picture of the editor, banked as a visual baseline a later diff would trust. This path cannot do that, needs no screen-recording permission, and is correct with nothing on screen at all.

All three capture the visible viewport by default, so a baseline taken on one platform is comparable with the same app on another. On a platform with no webview API to call, capture reports no-provider rather than returning a plausible wrong image.

**`fullPage` is Linux-only.** WebKitGTK can render a whole document offscreen; `takeSnapshot` and `CapturePreview` only give what is composited. Asked for it, macOS and Windows refuse with `full-page-unsupported` rather than quietly returning the viewport — an image missing everything below the fold, banked as a full-page baseline, stays green forever about a region it never captured.

### Headless

`on_page_load` parks the window when `RETICLE_HEADLESS=1`:

```sh
RETICLE_HEADLESS=1 cargo tauri dev
```

The ordering matters and is the whole reason this is a function rather than a config flag. Acting during `setup` runs _before_ the webview has been presented, and a webview that has never been presented never loads its page — so the app answers nothing. Show, load, then park.

On macOS the park is off-screen, not `hide()`. A loaded WKWebView that is then hidden has been observed to go quiet after a pause (capture still works, because it renders the webview); parking keeps the page scheduled without claiming every Mac will hit that pause. Linux and Windows still hide: WebKitGTK keeps executing while hidden.

`xvfb-run -a cargo tauri dev` also works on Linux and needs no app-side change.
