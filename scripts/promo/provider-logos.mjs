const IDENTIFICATION_USE = "识别性品牌使用：仅标识 BiliScript 中对应的平台预设；保持官方标志原样，不暗示合作、背书或归属关系。";

export const PROVIDER_LOGOS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    file: "deepseek.svg",
    officialFileUrl: "https://fe-static.deepseek.com/chat/favicon.svg",
    sourcePage: "https://chat.deepseek.com/",
    usageBasis: "项目维护者确认在开源、非商业产品演示中按识别性使用，不暗示合作或背书；官方平台条款含商标使用限制，未声称已获许可。",
    usageBasisUrl: "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html"
  },
  {
    id: "qwen",
    name: "Qwen",
    file: "qwen-symbol.png",
    officialFileUrl: "https://chat.qwen.ai/static/logo.png",
    sourcePage: "https://chat.qwen.ai/manifest.json",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "zhipu",
    name: "GLM",
    file: "glm.png",
    officialFileUrl: "https://open.bigmodel.cn/static/images/favicon.png",
    sourcePage: "https://open.bigmodel.cn/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "moonshot",
    name: "Kimi",
    file: "kimi.ico",
    officialFileUrl: "https://www.kimi.com/favicon.ico",
    sourcePage: "https://www.kimi.com/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "minimax",
    name: "MiniMax",
    file: "minimax.ico",
    officialFileUrl: "https://www.minimaxi.com/favicon.ico",
    sourcePage: "https://www.minimaxi.com/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "mimo",
    name: "Mimo",
    file: "mimo-platform.png",
    officialFileUrl: "https://platform.xiaomimimo.com/favicon.png",
    sourcePage: "https://platform.xiaomimimo.com/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "opencodego",
    name: "Opencode Go",
    file: "opencode.svg",
    officialFileUrl: "https://opencode.ai/favicon.svg",
    sourcePage: "https://opencode.ai/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    file: "openrouter.svg",
    officialFileUrl: "https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-ink.svg",
    sourcePage: "https://openrouter.ai/brand",
    usageBasis: "官方品牌资产页提供 SVG 下载，并要求不要拉伸、改色或重组标志；本片仅等比缩放。",
    usageBasisUrl: "https://openrouter.ai/brand"
  },
  {
    id: "stepfun",
    name: "Stepfun",
    file: "stepfun.svg",
    officialFileUrl: "https://www.stepfun.com/step_favicon.svg",
    sourcePage: "https://www.stepfun.com/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "modelscope",
    name: "ModelScope",
    file: "modelscope.ico",
    officialFileUrl: "https://modelscope.cn/favicon.ico",
    sourcePage: "https://modelscope.cn/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "amd",
    name: "AMD Radeon Cloud",
    file: "amd.ico",
    officialFileUrl: "https://www.amd.com/content/dam/code/images/favicon/favicon.ico",
    sourcePage: "https://www.amd.com/en.html",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "sensenova",
    name: "SenseNova",
    file: "sensenova-icon.png",
    officialFileUrl: "https://www.sensenova.cn/icon.png",
    sourcePage: "https://www.sensenova.cn/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "ollama",
    name: "Ollama",
    file: "ollama.png",
    officialFileUrl: "https://ollama.com/public/ollama.png",
    sourcePage: "https://ollama.com/",
    usageBasis: IDENTIFICATION_USE
  },
  {
    id: "gemini",
    name: "Gemini",
    file: "gemini.svg",
    officialFileUrl: "https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg",
    sourcePage: "https://gemini.google.com/",
    usageBasis: IDENTIFICATION_USE
  }
].map((logo) => ({...logo, acquiredAt: "2026-10-27", modifications: "仅等比缩放；未改色、重绘、拉伸或重组。"}));
