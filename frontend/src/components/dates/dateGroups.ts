import { AnnualDate, DateLink } from '../../types/annualDates';
import { DetectedDate, detectDates, occurrenceIndex } from '../../utils/dateDetection';
import { describeRule, formatOccurrence, nextOccurrence, occurrenceOn, Occurrence } from '../../utils/annualDates';

/**
 * The dates in a request, grouped: every mention of the same date (and end date) is one group, so
 * "Sunday, July 12th", "23:59 PT on Sunday, July 12th" and "July 12th" are tracked, linked and
 * updated together. Shared by "Dates in this request" and the bubbles in the review editor.
 */

export interface DateSource {
  field: DateLink['field'];
  /** "the text", "the blurb" */
  label: string;
  /** Plain text */
  text: string;
}

export interface Mention {
  /** Stable for the text: field, the text as written and which occurrence of it. */
  key: string;
  source: DateSource;
  found: DetectedDate;
  /** Which occurrence of found.text in the source (0 = first), to find this one in the editor. */
  occurrence: number;
  link?: DateLink;
}

export type GroupStatus = 'ok' | 'stale' | 'match' | 'untracked' | 'gone';

export interface DateGroup {
  key: string;
  date: string;
  endDate?: string;
  mentions: Mention[];
  /** The annual date a mention is linked to. */
  entry?: AnnualDate;
  /** Linked, but its annual date was deleted. */
  linkedToGone: boolean;
  /** The occurrence the text should show (linked groups). */
  target?: Occurrence;
  /** Annual dates that fall on this date (unlinked groups). */
  matches: AnnualDate[];
  status: GroupStatus;
}

/** The mention with the most to say (times, an end), for the Track dialog. */
export function bestMention(group: DateGroup): Mention {
  return group.mentions.find((m) => m.found.startTime && m.found.endTime)
    || group.mentions.find((m) => m.found.startTime)
    || group.mentions[0];
}

export function buildDateGroups(
  sources: DateSource[],
  links: DateLink[],
  referenceYmd: string,
  annualDates: AnnualDate[],
): { groups: DateGroup[]; orphanLinks: DateLink[] } {
  const byId = new Map(annualDates.map((e) => [e.id, e]));
  const groups = new Map<string, DateGroup>();
  const used = new Set<string>();
  for (const source of sources) {
    for (const found of detectDates(source.text, referenceYmd)) {
      const occurrence = occurrenceIndex(source.text, found);
      const link = links.find((l) => l.field === source.field && l.text === found.text);
      if (link) used.add(link.id);
      const key = `${found.date}|${found.endDate || ''}`;
      const group = groups.get(key) || {
        key, date: found.date, endDate: found.endDate, mentions: [], linkedToGone: false, matches: [], status: 'untracked' as GroupStatus,
      };
      group.mentions.push({ key: `${source.field}|${found.text}|${occurrence}`, source, found, occurrence, link });
      groups.set(key, group);
    }
  }

  for (const group of Array.from(groups.values())) {
    const linked = group.mentions.filter((m) => m.link);
    group.entry = linked.map((m) => byId.get(m.link!.annualDateId)).find(Boolean);
    group.linkedToGone = linked.length > 0 && !group.entry;
    if (group.entry) {
      const target = nextOccurrence(group.entry, referenceYmd);
      group.target = target;
      const stale = target.date !== group.date || (!!target.endDate && target.endDate !== group.endDate);
      group.status = stale ? 'stale' : 'ok';
    } else if (group.linkedToGone) {
      group.status = 'gone';
    } else {
      const best = bestMention(group).found;
      group.matches = annualDates.filter((entry) => {
        const occurrence = occurrenceOn(entry, group.date);
        return !!occurrence && (!best.startTime || !occurrence.startTime || occurrence.startTime === best.startTime);
      });
      group.status = group.matches.length ? 'match' : 'untracked';
    }
  }

  return {
    groups: Array.from(groups.values()),
    orphanLinks: links.filter((l) => !used.has(l.id)),
  };
}

/** One line about a group, for a bubble's tooltip. */
export function groupSummary(group: DateGroup): string {
  const when = formatOccurrence({ date: group.date, endDate: group.endDate });
  switch (group.status) {
    case 'ok':
      return `${when} · ${group.entry!.name} (${describeRule(group.entry!.rule)}): right for ${group.target!.year}`;
    case 'stale':
      return `${when} · ${group.entry!.name}: ${group.target!.year} is ${formatOccurrence(group.target!)}. Update it in Dates in this request`;
    case 'match':
      return `${when} · looks like ${group.matches[0].name}. Link it in Dates in this request`;
    case 'gone':
      return `${when} · its annual date was deleted`;
    default:
      return `${when} · not tracked. Track it in Dates in this request`;
  }
}
