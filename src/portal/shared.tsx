import {useQuery} from '@tanstack/react-query';
import {useCallback, useSyncExternalStore} from 'react';

import type {Abilities, Viewer} from '../lib/types';
import {meQuery, siteQuery} from './queries';

/** Data helpers every portal screen uses. The visual pieces are the kit: `./ui`. */

export const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(iso))
    : '—';

/** "3 min ago", "yesterday", "12 Oct": for activity feeds and "last seen". */
export function ago(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 7 * 86_400) return rtf.format(-Math.floor(seconds / 86_400), 'day');
  return new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium'}).format(new Date(iso));
}

export interface Me {
  viewer: Viewer;
  roles: string[];
  abilities: Abilities;
}

/** Who is signed in, and what the portal may SHOW them. Shared by every screen. */
export function useMe() {
  return useQuery(meQuery);
}

/** The brand, for the sidebar. Public and cached on the server. */
export function useSite() {
  return useQuery(siteQuery);
}

/**
 * A count for a stat tile from the FIRST page of a keyset list: "12", or
 * "25+" when there are more. Never a COUNT query per request; a total that
 * must be exact comes from a counter kept in the Site Database on write.
 */
export const pageCount = (rows: unknown[] | undefined, more: boolean) =>
  rows ? `${rows.length}${more ? '+' : ''}` : null;

/**
 * Whether a media query matches now, and again whenever that changes
 * (`useMediaQuery('(min-width: 1281px)')`). For a choice that CSS alone can't
 * make, such as rendering controls in a side pane OR a drawer, never both.
 * Use the design system's breakpoints (640 / 1024 / 1280). False without
 * `matchMedia` (and while rendering on a server).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && Boolean(window.matchMedia) && window.matchMedia(query).matches,
    () => false
  );
}

const TICKET_NUMBER_RE = /^\d{1,9}$/;

/**
 * A ticket number from a URL (`/support/$ticketId`, `?ticket=`; the router may already have
 * parsed it to a number), else null: 1–9 digits, above 0. Anything else is "no such ticket".
 */
export function ticketNumberOf(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!TICKET_NUMBER_RE.test(text)) return null;
  const number = Number(text);
  return number > 0 ? number : null;
}
