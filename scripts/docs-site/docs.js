(() => {
  const THEME_KEY = "biliscript-docs-theme";
  const PALETTE_KEY = "biliscript-docs-palette";
  const colorMeta = document.querySelector('meta[name="color-scheme"]');
  const root = document.documentElement;

  function getEffectiveScheme() {
    const content = colorMeta?.getAttribute("content") || "light dark";
    if (content === "light" || content === "dark") return content;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyScheme(value) {
    if (!colorMeta) return;
    colorMeta.setAttribute("content", value);
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = getEffectiveScheme();
      const target = current === "dark" ? "light" : "dark";
      const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      try {
        if (target === system) {
          localStorage.removeItem(THEME_KEY);
          applyScheme("light dark");
        } else {
          localStorage.setItem(THEME_KEY, target);
          applyScheme(target);
        }
      } catch (_) {
        applyScheme(target);
      }
    });
  });

  function applyPalette(palette) {
    const next = palette === "editorial" ? "editorial" : "flyme";
    root.setAttribute("data-palette", next);
    document.querySelectorAll("[data-palette-option]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-palette-option") === next));
    });
  }

  document.querySelectorAll("[data-palette-option]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-palette-option") || "flyme";
      applyPalette(target);
      try {
        localStorage.setItem(PALETTE_KEY, target);
      } catch (_) {}
    });
  });

  applyPalette(root.getAttribute("data-palette") || "flyme");

  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) {
      applyScheme(event.newValue === "light" || event.newValue === "dark" ? event.newValue : "light dark");
    } else if (event.key === PALETTE_KEY) {
      applyPalette(event.newValue || "flyme");
    }
  });

  const drawer = document.getElementById("mobile-drawer");
  const drawerOpenBtn = document.querySelector("[data-drawer-open]");
  const drawerCloseBtn = document.querySelector("[data-drawer-close]");

  if (drawer instanceof HTMLDialogElement && drawerOpenBtn) {
    drawerOpenBtn.addEventListener("click", () => {
      if (!drawer.open) {
        drawer.showModal();
        drawerOpenBtn.setAttribute("aria-expanded", "true");
      }
    });

    drawerCloseBtn?.addEventListener("click", () => drawer.close());

    drawer.addEventListener("click", (event) => {
      if (event.target === drawer) drawer.close();
    });

    drawer.addEventListener("close", () => {
      drawerOpenBtn.setAttribute("aria-expanded", "false");
    });
  }

  const showcaseImg = document.getElementById("hero-showcase-img");
  const showcaseCaption = document.getElementById("hero-showcase-caption");
  const showcaseZoomBtn = document.getElementById("hero-showcase-zoom");

  document.querySelectorAll("[data-showcase-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-showcase-tab]").forEach((el) => {
        el.setAttribute("aria-selected", String(el === tab));
      });
      const src = tab.getAttribute("data-src");
      const alt = tab.getAttribute("data-alt");
      const caption = tab.getAttribute("data-caption");
      if (showcaseImg && src) {
        showcaseImg.setAttribute("src", src);
        if (alt) showcaseImg.setAttribute("alt", alt);
      }
      if (showcaseCaption && caption) {
        showcaseCaption.textContent = caption;
      }
      if (showcaseZoomBtn && src) {
        showcaseZoomBtn.setAttribute("data-lightbox-src", src);
        if (caption) showcaseZoomBtn.setAttribute("data-lightbox-caption", caption);
        if (alt) showcaseZoomBtn.setAttribute("data-lightbox-alt", alt);
      }
    });
  });

  const cmdCode = document.getElementById("install-cmd-code");
  document.querySelectorAll("[data-cmd-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-cmd-tab]").forEach((el) => {
        el.setAttribute("aria-selected", String(el === tab));
      });
      const nextCmd = tab.getAttribute("data-cmd");
      if (cmdCode && nextCmd) {
        cmdCode.textContent = nextCmd;
      }
    });
  });

  const lightbox = document.getElementById("shot-lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxCaption = document.getElementById("lightbox-caption");
  const lightboxClose = document.getElementById("lightbox-close");

  if (lightbox instanceof HTMLDialogElement && lightboxImg) {
    document.querySelectorAll("[data-lightbox-src]").forEach((trigger) => {
      trigger.addEventListener("click", () => {
        const src = trigger.getAttribute("data-lightbox-src");
        const alt = trigger.getAttribute("data-lightbox-alt") || "";
        const caption = trigger.getAttribute("data-lightbox-caption") || "";
        if (!src) return;
        lightboxImg.setAttribute("src", src);
        lightboxImg.setAttribute("alt", alt);
        if (lightboxCaption) lightboxCaption.textContent = caption;
        lightbox.showModal();
      });
    });

    lightboxClose?.addEventListener("click", () => lightbox.close());
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) lightbox.close();
    });
  }

  const copyTimers = new WeakMap();
  let lastAnnounced = "";

  function legacyCopy(text) {
    const field = Object.assign(document.createElement("textarea"), { value: text });
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;inset-block-start:0;opacity:0";
    document.body.append(field);
    field.select();
    try {
      return document.execCommand("copy");
    } finally {
      field.remove();
    }
  }

  function reportCopy(button, ok) {
    const tip = button.nextElementSibling;
    clearTimeout(copyTimers.get(button));
    button.removeAttribute("data-copied");
    button.removeAttribute("data-failed");
    let message = ok ? "已复制" : "复制失败";
    if (message === lastAnnounced) message += "\u00A0";
    lastAnnounced = message;

    if (tip) tip.textContent = "";
    void button.offsetWidth;
    button.setAttribute(ok ? "data-copied" : "data-failed", "");
    requestAnimationFrame(() => {
      if (tip) tip.textContent = message;
    });

    copyTimers.set(
      button,
      setTimeout(() => {
        button.removeAttribute("data-copied");
        button.removeAttribute("data-failed");
        if (tip) tip.textContent = "";
      }, 1800)
    );
  }

  async function handleCopy(button, target) {
    const text = target.matches("input, textarea") ? target.value : (target.textContent || "").trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        reportCopy(button, true);
        return;
      }
      throw new Error("Clipboard unavailable");
    } catch {
      reportCopy(button, legacyCopy(text));
    }
  }

  if ("CommandEvent" in window) {
    document.addEventListener(
      "command",
      (event) => {
        if (event.command === "--copy" && event.source && event.target) {
          handleCopy(event.source, event.target);
        }
      },
      true
    );
  } else {
    document.addEventListener("click", (event) => {
      const targetEl = event.target instanceof Element ? event.target : null;
      const button = targetEl?.closest('button[command="--copy"]');
      if (!button) return;
      const targetId = button.getAttribute("commandfor");
      const target = targetId ? document.getElementById(targetId) : null;
      if (target) handleCopy(button, target);
    });
  }

  const tocNav = document.querySelector(".toc-nav");
  if (tocNav) {
    const links = Array.from(tocNav.querySelectorAll('a[href^="#"]'));
    if (CSS.supports("scroll-target-group: auto")) {
      const syncAria = () => {
        const active = tocNav.querySelector("a:target-current");
        links.forEach((link) => {
          link.setAttribute("aria-current", link === active ? "true" : "false");
        });
      };
      syncAria();
      document.addEventListener("scrollend", syncAria, { passive: true });
    } else if (links.length > 0) {
      const headingIds = links.map((l) => l.getAttribute("href").slice(1));
      const headings = headingIds
        .map((id) => document.getElementById(id))
        .filter((el) => Boolean(el));
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const id = entry.target.getAttribute("id");
              links.forEach((link) => {
                const active = link.getAttribute("href") === `#${id}`;
                link.classList.toggle("target-current", active);
                link.setAttribute("aria-current", String(active));
              });
            }
          }
        },
        { rootMargin: "-20% 0px -65% 0px", threshold: 0 }
      );
      headings.forEach((h) => observer.observe(h));
    }
  }
})();
