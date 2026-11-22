import { mountOnboardingPage } from "./onboarding.js";

if (typeof document !== "undefined" && document.getElementById("onboardingAiForm")) {
  void mountOnboardingPage(document);
}

export {};
