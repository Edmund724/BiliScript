#!/usr/bin/env node
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DIST,
  artifactDir,
  attachPage,
  launchBrowser,
  log,
  screenshot,
  teardown,
  writeEvidence
} from "../harness.mjs";

const NAME = "subtitle-spacing";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const css = ["tokens-primitive.css", "reader-gate.css", "reader.css"]
  .map((file) => readFileSync(path.join(DEFAULT_DIST, "entry", "styles", file), "utf8"))
  .join("\n");
const checks = [];
const measurements = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

const browser = await launchBrowser();
const page = await attachPage(browser);
try {
  await page.cdp.send("Page.setDocumentContent", {
    frameId: page.target.id,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0;background:#eef1f5"><div id="biliscript-reading-view" class="open" data-theme="light" data-palette="flyme" style="position:static;inset:auto;width:540px;height:auto;padding:0;display:block;transform:none"><div class="biliscript-reading-main"><div id="biliscript-reading-subtitle" class="biliscript-reading-subtitle" style="overflow:visible"><button class="biliscript-reading-item" data-index="0"><span class="biliscript-reading-time">0:01:25</span><span class="biliscript-reading-text">去定义自己的AI硬件</span></button><button class="biliscript-reading-item is-active" data-index="1"><span class="biliscript-reading-time">0:01:26</span><span class="biliscript-reading-text">对我觉得刚好乐哥说到这个</span></button></div></div></div></body></html>`
  });

  for (const dpr of [1, 1.5, 2]) {
    await page.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 900,
      deviceScaleFactor: dpr,
      mobile: false
    });
    for (const fontScale of [1, 1.1, 1.2, 1.4, 1.6]) {
      for (const width of [540, 650]) {
        const metric = await page.cdp.evaluate(`(async () => {
          const view = document.getElementById('biliscript-reading-view');
          view.style.width = '${width}px';
          view.style.setProperty('--biliscript-reader-font-scale', '${fontScale}');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const active = document.querySelector('.biliscript-reading-item.is-active');
          const inactive = document.querySelector('.biliscript-reading-item:not(.is-active)');
          const time = active.querySelector('.biliscript-reading-time');
          const activeText = active.querySelector('.biliscript-reading-text');
          const inactiveText = inactive.querySelector('.biliscript-reading-text');
          const timeRect = time.getBoundingClientRect();
          const textRect = activeText.getBoundingClientRect();
          const round = value => Math.round(value * 100) / 100;
          return {
            dpr: devicePixelRatio,
            fontScale: ${fontScale},
            width: ${width},
            timeWidth: round(timeRect.width),
            visualGap: round(textRect.left - timeRect.right),
            textAlignmentDelta: round(Math.abs(textRect.left - inactiveText.getBoundingClientRect().left)),
            timeColumn: getComputedStyle(active).gridTemplateColumns.split(' ')[0]
          };
        })()`);
        measurements.push(metric);
        check(`spacing-dpr${dpr}-font${fontScale}-width${width}`, metric.visualGap >= 12, metric);
        check(`alignment-dpr${dpr}-font${fontScale}-width${width}`, metric.textAlignmentDelta <= 0.1, metric);
      }
    }
  }

  await page.cdp.evaluate(`(() => {
    const view = document.getElementById('biliscript-reading-view');
    view.style.width = '540px';
    view.style.setProperty('--biliscript-reader-font-scale', '1.2');
  })()`);
  await screenshot(page.cdp, path.join(OUT_DIR, "default-width-font120-dpr2.png"));
  await writeEvidence(OUT_DIR, { failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name), checks, measurements });
  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
} finally {
  await teardown({ browser, cdps: [page.cdp] });
}
