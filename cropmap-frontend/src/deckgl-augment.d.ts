// src/deckgl-augment.d.ts
import '@deck.gl/core';

declare module '@deck.gl/core' {
  interface DeckProps {
    /** Allow custom map library such as maplibre-gl */
    mapLib?: any;
  }
}
