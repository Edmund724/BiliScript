import {Config} from "@remotion/cli/config";

Config.setPublicDir("./.scratch/promo/public");
Config.setBundleOutDir("./.scratch/promo/bundle");
Config.setRspack(true);
Config.setShouldOpenBrowser(false);
Config.setVideoImageFormat("jpeg");
Config.setStillImageFormat("png");
Config.setJpegQuality(95);
Config.setCrf(17);
Config.setPixelFormat("yuv420p");
Config.setAudioBitrate("192k");
Config.setX264Preset("medium");
