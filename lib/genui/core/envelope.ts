export const GENUI_LIBRARY_VERSION = 1;

export type GroundedRecord =
  | {
      cta?: string;
      features?: string[];
      id: string;
      interval?: string;
      kind: "entity";
      price?: string;
      summary?: string;
      tags?: string[];
      title: string;
      url: string;
    }
  | {
      id: string;
      kind: "document";
      title: string;
      url: string;
      excerpt: string;
      revisedAt?: string;
    }
  | {
      id: string;
      kind: "metric";
      label: string;
      series?: number[];
      trend?: "up" | "down" | "flat";
      unit?: string;
      value: string;
    }
  | {
      id: string;
      kind: "media";
      title: string;
      url: string;
      mimeType: string;
    };

export interface CompositionEnvelope {
  fallbackText: string;
  libraryVersion: number;
  openuiText: string;
  records: GroundedRecord[];
  requestId: string;
}
