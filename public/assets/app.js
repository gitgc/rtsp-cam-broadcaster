/* Player bootstrap tuned for STABILITY over latency (it's a chicken cam, not a
   video call). We sit a few segments behind the live edge, buffer generously,
   and only show the overlay after a *sustained* freeze — brief rebuffers are
   invisible. Recovery jumps back to the live edge rather than reloading. */
(function () {
  "use strict";

  var STREAM_URL = "/hls/stream.m3u8";
  var SOFT_FREEZE_MS = 3000; // show a quiet "Buffering…" after this long frozen
  var HARD_FREEZE_MS = 10000; // escalate to "Reconnecting…" + recover only after a
  // real, sustained stall — mobile/cellular rebuffers of a few seconds are normal
  // and self-heal, so we don't want to alarm on them.

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

/* Live viewer counter: heartbeat every 10s, drop instantly on tab close. */
(function () {
  "use strict";

  var viewersEl = document.getElementById("viewers");
  if (!viewersEl) return;

  var HEARTBEAT_MS = 10000;

  function newId() {
    return window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + "-" + String(Math.random()).slice(2);
  }

  // Persist the id so refreshing or reopening the URL (even in a new tab, since
  // localStorage is shared across tabs) reuses the same session instead of
  // counting as a new viewer. One browser = one viewer.
  function stableId() {
    var KEY = "cluckcam:viewer-id";
    try {
      var existing = localStorage.getItem(KEY);
      if (existing) return existing;
      var fresh = newId();
      localStorage.setItem(KEY, fresh);
      return fresh;
    } catch (e) {
      // Private mode / storage disabled — fall back to a per-load id.
      return newId();
    }
  }

  var id = stableId();

  function render(n) {
    if (typeof n === "number") viewersEl.textContent = n;
  }

  function beat() {
    fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id }),
      keepalive: true,
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (data) render(data.viewers);
      })
      .catch(function () {
        /* transient — next beat will refresh */
      });
  }

  beat();
  setInterval(beat, HEARTBEAT_MS);

  // Leave promptly when the tab is closed/hidden so the count stays honest.
  window.addEventListener("pagehide", function () {
    try {
      navigator.sendBeacon("/api/leave?id=" + encodeURIComponent(id));
    } catch (e) {
      /* ignore */
    }
  });
})();

/* "Recently spotted" — poll Frigate detections and render snapshot cards. */
(function () {
  "use strict";

  var section = document.getElementById("sightings");
  var grid = document.getElementById("sightings-grid");
  if (!section || !grid) return;

  var POLL_MS = 20000;

  // Click-to-enlarge lightbox, built once and shared by every card.
  var opener = null;
  var lb = document.createElement("div");
  lb.className = "lightbox";
  lb.hidden = true;
  lb.innerHTML =
    '<button class="lightbox-close" type="button" aria-label="Close">&times;</button>' +
    '<figure class="lightbox-inner">' +
    '<img class="lightbox-img" alt="">' +
    '<figcaption class="lightbox-cap"><span class="lightbox-name"></span><time class="lightbox-time"></time></figcaption>' +
    "</figure>";
  document.body.appendChild(lb);
  var lbImg = lb.querySelector(".lightbox-img");
  var lbName = lb.querySelector(".lightbox-name");
  var lbTime = lb.querySelector(".lightbox-time");
  var lbClose = lb.querySelector(".lightbox-close");

  function openLightbox(d, name, from) {
    opener = from || null;
    lbImg.src = d.image; // same URL as the card — already cached, so instant
    lbImg.alt = name;
    lbName.textContent = name;
    lbTime.textContent = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "spotted recently";
    lb.hidden = false;
    lbClose.focus();
  }
  function closeLightbox() {
    lb.hidden = true;
    lbImg.removeAttribute("src");
    if (opener && opener.focus) opener.focus();
    opener = null;
  }
  lbClose.addEventListener("click", closeLightbox);
  lb.addEventListener("click", function (e) {
    if (e.target === lb) closeLightbox(); // click the backdrop, not the image
  });
  document.addEventListener("keydown", function (e) {
    if (!lb.hidden && (e.key === "Escape" || e.key === "Esc")) closeLightbox();
  });
  var EMOJI = {
    bear: "🐻", deer: "🦌", dog: "🐕", cat: "🐈", bird: "🐦",
    raccoon: "🦝", fox: "🦊", squirrel: "🐿️", rabbit: "🐇", person: "🧍",
  };

  function titleCase(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function ago(ms) {
    if (!ms) return "recently";
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function render(items) {
    if (!items || !items.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    grid.textContent = "";
    items.forEach(function (d) {
      var fullName = (EMOJI[d.label] || "🐾") + " " + titleCase(d.label);

      var card = document.createElement("figure");
      card.className = "sighting";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", "Enlarge " + titleCase(d.label) + " snapshot");

      var img = document.createElement("img");
      img.loading = "lazy";
      img.alt = titleCase(d.label);
      img.src = d.image;

      var cap = document.createElement("figcaption");
      var name = document.createElement("span");
      name.className = "sighting-name";
      name.textContent = fullName;

      var when = document.createElement("time");
      when.className = "sighting-time";
      when.textContent = ago(d.lastSeen);
      if (d.lastSeen) when.title = new Date(d.lastSeen).toLocaleString();

      cap.appendChild(name);
      cap.appendChild(when);
      card.appendChild(img);
      card.appendChild(cap);

      card.addEventListener("click", function () {
        openLightbox(d, fullName, card);
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openLightbox(d, fullName, card);
        }
      });

      grid.appendChild(card);
    });
  }

  function poll() {
    fetch("/api/detections", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (data) render(data.detections);
      })
      .catch(function () {
        /* transient */
      });
  }

  poll();
  setInterval(poll, POLL_MS);
})();
