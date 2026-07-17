/* Player bootstrap tuned for STABILITY over latency (it's a chicken cam, not a
   video call). We sit a few segments behind the live edge, buffer generously,
   and only show the overlay after a *sustained* freeze — brief rebuffers are
   invisible. Recovery jumps back to the live edge rather than reloading. */
(function () {
  "use strict";

  var STREAM_URL = "/hls/stream.m3u8";
  var SOFT_FREEZE_MS = 2500; // show a quiet "Buffering…" after this long frozen
  var HARD_FREEZE_MS = 6000; // escalate + actively recover after this long

  var video = document.getElementById("video");
  var overlay = document.getElementById("overlay");
  var statusEl = document.getElementById("status");
  var liveEl = document.getElementById("live");

  var hls = null;
  var lastProgressAt = Date.now();
  var lastMediaTime = 0;
  var recovering = false;

  function showOverlay(message) {
    overlay.classList.remove("hidden");
    if (message) statusEl.textContent = message;
    liveEl.classList.remove("on");
  }
  function hideOverlay() {
    overlay.classList.add("hidden");
    liveEl.classList.add("on");
  }

  // Any real playback progress means we're healthy.
  function markProgress() {
    lastProgressAt = Date.now();
    hideOverlay();
  }
  video.addEventListener("timeupdate", function () {
    if (video.currentTime !== lastMediaTime) {
      lastMediaTime = video.currentTime;
      markProgress();
    }
  });
  video.addEventListener("playing", markProgress);

  // Gentle recovery: resume loading and let the buffer refill / hls.js nudge
  // across gaps. We deliberately DON'T seek to the live edge here — that's the
  // point with the least buffer, so forcing it on every hiccup just re-stalls.
  // hls.js catches up on its own once it drifts past liveMaxLatencyDuration.
  function recover() {
    if (recovering) return;
    recovering = true;
    setTimeout(function () {
      recovering = false;
    }, 4000);
    if (hls) hls.startLoad();
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  // Single watchdog drives all "is it stuck?" decisions off actual progress,
  // instead of the noisy native stalled/waiting events.
  setInterval(function () {
    if (video.paused || video.ended || video.readyState === 0) return;
    var frozenMs = Date.now() - lastProgressAt;
    if (frozenMs > HARD_FREEZE_MS) {
      showOverlay("Reconnecting…");
      recover();
    } else if (frozenMs > SOFT_FREEZE_MS) {
      showOverlay("Buffering…");
    }
  }, 1000);

  var canNativeHls = video.canPlayType("application/vnd.apple.mpegurl");

  if (window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({
      lowLatencyMode: false, // stability > latency
      liveSyncDurationCount: 4, // sit ~4 segments behind live for a buffer cushion
      liveMaxLatencyDurationCount: 15, // allow drifting well back before hard-seeking
      maxBufferLength: 30, // build up to 30s of forward buffer when available
      maxMaxBufferLength: 60,
      backBufferLength: 30,
    });

    hls.loadSource(STREAM_URL);
    hls.attachMedia(video);

    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    });
    hls.on(window.Hls.Events.FRAG_BUFFERED, markProgress);

    hls.on(window.Hls.Events.ERROR, function (_event, data) {
      if (!data.fatal) return;
      switch (data.type) {
        case window.Hls.ErrorTypes.NETWORK_ERROR:
          showOverlay("Reconnecting…");
          setTimeout(function () {
            hls.startLoad();
          }, 1500);
          break;
        case window.Hls.ErrorTypes.MEDIA_ERROR:
          showOverlay("Recovering…");
          hls.recoverMediaError();
          break;
        default:
          showOverlay("Reconnecting…");
          setTimeout(function () {
            hls.destroy();
            location.reload();
          }, 5000);
      }
    });
  } else if (canNativeHls) {
    // Safari plays HLS natively; its own buffering is already conservative.
    video.src = STREAM_URL;
    video.addEventListener("error", function () {
      showOverlay("Reconnecting…");
      setTimeout(function () {
        video.src = STREAM_URL;
        video.load();
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      }, 3000);
    });
    var np = video.play();
    if (np && np.catch) np.catch(function () {});
  } else {
    showOverlay("Your browser can’t play this stream.");
  }
})();
