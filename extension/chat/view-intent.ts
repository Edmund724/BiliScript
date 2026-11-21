export interface ViewResetStateIntent {
  kind: "state";
  html: string;
}

export interface ViewResetSetupIntent {
  kind: "setup";
}

export type ViewResetIntent = ViewResetStateIntent | ViewResetSetupIntent;
