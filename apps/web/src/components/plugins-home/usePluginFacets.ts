// Faceted categorisation hook for the Plugins home section.
//
// Two-level starter model: the top row is the artifact kind
// (Prototype / Slides / Image / Video / HyperFrames / Audio). Prototype,
// Slides, Image, and Video expose scene buckets from the prompt-taxonomy
// analysis; HyperFrames and Audio stay flat.
//
// Featured and Saved are orthogonal category-row modes: each overrides
// category selection rather than AND-composing with it, so a curated or saved
// pick is never accidentally hidden behind a still-selected category pill.

import { useEffect, useMemo, useState } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  applyFacetSelection,
  buildFacetCatalog,
  filterByQuery,
  resolveDefaultSelection,
  type FacetCatalog,
  type FacetSelection,
} from './facets';
import { sortByVisualAppeal } from './visualScore';
import { featuredCommunityPriority } from './curatedPriority';

export type FilterMode = 'featured' | 'all' | 'saved';

interface UsePluginFacetsArgs {
  plugins: InstalledPluginRecord[];
  savedPluginIds?: ReadonlySet<string>;
  preferDefaultFacet?: boolean;
  preferFeaturedMode?: boolean;
  locale?: string;
}

export interface UsePluginFacetsResult {
  visiblePlugins: InstalledPluginRecord[];
  featuredList: InstalledPluginRecord[];
  savedList: InstalledPluginRecord[];
  filtered: InstalledPluginRecord[];
  catalog: FacetCatalog;
  selection: FacetSelection;
  pickCategory: (slug: string | null) => void;
  pickSubcategory: (slug: string | null) => void;
  pickFeatured: () => void;
  clearFacets: () => void;
  hasActiveFacet: boolean;
  mode: FilterMode;
  setMode: (next: FilterMode) => void;
  query: string;
  setQuery: (next: string) => void;
  totalVisible: number;
}

const EMPTY_SELECTION: FacetSelection = {
  category: null,
  subcategory: null,
};

export function usePluginFacets({
  plugins,
  savedPluginIds,
  preferDefaultFacet = true,
  preferFeaturedMode = false,
  locale,
}: UsePluginFacetsArgs): UsePluginFacetsResult {
  const defaultMode: FilterMode = preferFeaturedMode ? 'featured' : 'all';
  const [mode, setMode] = useState<FilterMode>(defaultMode);
  const [selection, setSelection] = useState<FacetSelection>(EMPTY_SELECTION);
  const [query, setQuery] = useState('');
  // Apply the preferred default selection once, on the first render that
  // sees a non-empty catalog. Using a flag (instead of a useState lazy
  // initializer) handles the realistic case where `args.plugins` is
  // empty at first paint and arrives a tick later.
  const [bootstrapped, setBootstrapped] = useState(false);

  // Atoms are infrastructure pieces (`code-import`, `patch-edit`) that
  // are not user-facing on the home grid; the original section already
  // filtered them out and we preserve that contract. We immediately
  // sort by visual-appeal score so the first viewport leads with the
  // cinematic decks / image / video templates rather than alphabetical
  // bundled noise. Featured plugins get a +1000 score boost inside the
  // sort so curator picks stay anchored to the front of every category view.
  const visiblePlugins = useMemo(
    () =>
      sortByVisualAppeal(
        plugins.filter((p) => p.manifest?.od?.kind !== 'atom'),
      ),
    [plugins],
  );

  const savedList = useMemo(
    () => visiblePlugins.filter((plugin) => savedPluginIds?.has(plugin.id)),
    [savedPluginIds, visiblePlugins],
  );

  const featuredList = useMemo(
    () =>
      visiblePlugins.filter((plugin) => featuredCommunityPriority(plugin) !== null),
    [visiblePlugins],
  );

  const catalog = useMemo(() => buildFacetCatalog(visiblePlugins), [visiblePlugins]);

  useEffect(() => {
    if (bootstrapped) return;
    if (visiblePlugins.length === 0) return;
    if (!preferDefaultFacet || preferFeaturedMode) {
      setBootstrapped(true);
      return;
    }
    const next = resolveDefaultSelection(catalog);
    if (next.category !== null) {
      setSelection(next);
    }
    setBootstrapped(true);
  }, [bootstrapped, preferDefaultFacet, preferFeaturedMode, visiblePlugins.length, catalog]);

  // The visual-appeal sort is applied at `visiblePlugins` derivation
  // (above), so any downstream `applyFacetSelection` slice preserves
  // the ranking. We do not re-sort here because filter + featured
  // override should both remain stable across selections.
  const filtered = useMemo(() => {
    const base =
      mode === 'featured'
        ? featuredList.length > 0
          ? featuredList
          : visiblePlugins
        : mode === 'saved'
        ? savedList
        : applyFacetSelection(visiblePlugins, selection);
    return filterByQuery(base, query, locale);
  }, [mode, featuredList, savedList, visiblePlugins, selection, query, locale]);

  function pickCategory(slug: string | null): void {
    const clearsActiveCategory = selection.category === slug;
    setMode(clearsActiveCategory ? defaultMode : 'all');
    setSelection(clearsActiveCategory ? EMPTY_SELECTION : {
      category: slug,
      subcategory: null,
    });
  }

  function pickSubcategory(slug: string | null): void {
    if (mode !== 'all') setMode('all');
    setSelection((prev) => ({
      ...prev,
      subcategory: prev.subcategory === slug ? null : slug,
    }));
  }

  function pickFeatured(): void {
    setMode('featured');
    setSelection(EMPTY_SELECTION);
  }

  function clearFacets(): void {
    setSelection(EMPTY_SELECTION);
    setQuery('');
    // Featured/Saved override the facet slice, so the empty-state "Clear
    // filters" CTA also has to leave override mode — otherwise clicking it
    // from an override + zero-match view just re-renders the same empty state.
    setMode(defaultMode);
  }

  const hasActiveFacet =
    selection.category !== null || selection.subcategory !== null || query.trim().length > 0;

  return {
    visiblePlugins,
    featuredList,
    savedList,
    filtered,
    catalog,
    selection,
    pickCategory,
    pickSubcategory,
    pickFeatured,
    clearFacets,
    hasActiveFacet,
    mode,
    setMode,
    query,
    setQuery,
    totalVisible: visiblePlugins.length,
  };
}
