export type WireTyres = {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
};

export type WireFrame = {
  ts: number;
  lap: number;
  pos: number;
  spd: number;
  thr: number;
  brk: number;
  str: number;
  gear: number;
  rpm: number;
  tyres: WireTyres;
};

export type StintTelemetry = {
  schema: string;
  recorder: {
    name: string;
    version: string;
  };
  session_id: string;
  note?: string;
  frame_count: number;
  frames: WireFrame[];
};

export type CleanFrame = WireFrame & {
  originalIndex: number;
  tyresC: WireTyres;
};

export type InvalidFrame = {
  index: number;
  ts: number;
  lap: number;
  pos: number;
  reasons: string[];
  frame: {
    spd: number;
    rpm: number;
    gear: number;
    thr: number;
    brk: number;
  };
};

export type Corner = {
  id: string;
  entryPos: number;
  apexPos: number;
  exitPos: number;
  direction: "left" | "right";
  peakMedianAbsSteeringDeg: number;
};
