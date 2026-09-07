//! Reticle support for a Tauri app: screenshots, and a headless mode that actually stays awake.
//!
//! Tauri has no preload stage, so there is nowhere to install a JavaScript shim before app code
//! runs. Everything here is therefore Rust-side, and the browser SDK finds it on its own: it invokes
//! `reticle_capture` through Tauri's internals when no preload channel exists. An app wires this up
//! with two lines in `main.rs` and nothing at all in its frontend.
//!
//! ```no_run
//! tauri::Builder::default()
//!     .invoke_handler(tauri::generate_handler![reticle_tauri::reticle_capture])
//!     .on_page_load(reticle_tauri::on_page_load)
//! # ;
//! ```

mod capture;

pub use capture::*;

use tauri::{Runtime, Webview};

/// Filename prefix the daemon requires before it will read a capture off disk.
///
/// Source of truth is `RETICLE_CAPTURE_FILE_PREFIX` in `@reticlehq/core`; the two cannot share a
/// module graph, so `desktop-contract.test.ts` asserts this file still spells it the same way.
const CAPTURE_FILE_PREFIX: &str = "reticle-capture-";

/// How long to wait for the webview to hand back a snapshot before giving up.
const SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Returned when `fullPage` is asked of a platform that can only give the composited viewport.
///
/// The SDK matches on this exact text, and `desktop-contract.test.ts` pins it to the daemon's
/// `VisualReason.FULL_PAGE_UNSUPPORTED`. Refusing beats downgrading: a caller who asked for the
/// whole scroll height and silently got the visible part banks a baseline that says nothing about
/// the content below the fold, and a later diff calls it a match.
pub const FULL_PAGE_UNSUPPORTED: &str = "full-page-unsupported";

/// Environment variable that asks for a window nobody can see.
const HEADLESS_ENV: &str = "RETICLE_HEADLESS";

/// Far enough off every display that nothing is on screen, without calling `hide()`.
///
/// A hidden WKWebView on macOS has been observed to stop executing JavaScript after a short pause.
/// Capture still works (it renders the webview, not the screen). Parking keeps `document.hidden`
/// false so the page keeps being scheduled. That pause is not something every machine demonstrates,
/// so this is the mechanism we can show, not a claim that `hide()` is dead everywhere.
///
/// AppKit is not guaranteed to honour this origin. `constrainFrameRect:toScreen:` can pull a window
/// back so its title bar stays on a display (Stage Manager, Mission Control, extra screens). A
/// headless run that then shows a window is louder than the pause we are avoiding; we still park
/// rather than hide because a visible-but-unwanted window is recoverable and a silent webview is not.
#[cfg(target_os = "macos")]
const OFFSCREEN_PX: i32 = -32_000;

/// Park the window once its page has loaded, when `RETICLE_HEADLESS=1`.
///
/// The ordering is the entire trick, and getting it backwards is what made headless Tauri look
/// impossible: acting during `setup` runs BEFORE the webview has ever been presented, and a
/// webview that has never been presented never loads its page — so every command times out and
/// the app looks dead. Show, load, then park.
///
/// On macOS the park is off-screen, not `hide()`. A loaded WKWebView that is then hidden has been
/// observed to go quiet after a pause even though capture still works; parking is the path that
/// keeps the page scheduled without claiming every Mac will hit that pause. Linux and Windows still
/// `hide()`: WebKitGTK keeps executing while hidden, which is why the Linux desktop battery stays
/// green.
///
/// Screenshots keep working, because `reticle_capture` renders the webview rather than the screen.
pub fn on_page_load<R: Runtime>(
    webview: &Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    if std::env::var(HEADLESS_ENV).as_deref() != Ok("1") {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let window = webview.window();
        let _ = window.set_position(tauri::PhysicalPosition::new(OFFSCREEN_PX, OFFSCREEN_PX));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview.window().hide();
    }
}
