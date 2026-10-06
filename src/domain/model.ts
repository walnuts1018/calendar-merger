export type Confidence = "strong" | "medium" | "weak";

export type CalendarOwnership = "mine" | "other" | "unknown";

export type CalendarView = "day" | "week" | "month" | "schedule" | "year" | "unknown";

export type CalendarKey = string;

export type EventRef = string;

export interface AdapterCapabilities {
  calendarIdentity: boolean;
  eventIdentity: boolean;
  calendarSidebar: boolean;
  eventStyling: boolean;
  merge: boolean;
}

export interface CalendarSnapshot {
  key: CalendarKey;
  label: string;
  confidence: Confidence;
  ownership: CalendarOwnership;
  nativeColor?: string;
  visible: boolean;
}

export interface CalendarPreferences {
  color?: string;
  opacity: number;
  groupId?: string;
}

export interface CalendarEvent {
  ref: EventRef;
  calendarKey: CalendarKey;
  calendarConfidence: Confidence;
  eventConfidence: Confidence;
  ownership: CalendarOwnership;
  title: string;
  dateKey: string;
  start: string;
  end: string;
  layoutKey?: string;
  allDay: boolean;
  view: CalendarView;
  domOrder: number;
  nativeColor?: string;
}

export interface MergeGroup {
  key: string;
  canonical: CalendarEvent;
  members: CalendarEvent[];
  calendarKeys: CalendarKey[];
}

export interface EventPresentation {
  backgroundColor: string;
  backgroundOpacity: number;
  spotlightFactor: number;
  hiddenByMerge: boolean;
  mergedCalendarColors: string[];
  mergedCount: number;
}

export interface CalendarGroup {
  id: string;
  name: string;
}

export interface VisibilityProfile {
  id: string;
  name: string;
  visibleCalendarKeys: CalendarKey[];
}
