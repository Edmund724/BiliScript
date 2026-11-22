import { startContentBootstrap } from "./content-bootstrap.js";

if (typeof chrome?.runtime?.getURL === "function") {
  startContentBootstrap()?.loadContentMain();
}

export {};
