# CropMap Visualization

The latest version is available here:
https://tcreed880.github.io/cropmap/

This project is an interactive map built with **React**, **Deck.GL**, and **MapLibre GL**.  
It visualizes harvested crop area (in hectares) across the contiguous United States using a hexagonal grid based on **H3 indexing**.

## Features

- Displays per-hex tile crop area using 3D extruded hexagons.
- Supports multiple crop types:
  - Dry Beans  
  - Chickpeas  
  - Lentils  
  - Peas
- Year selector with play/pause animation to view changes over time.
- Hover tooltips showing crop type, year, area, and confidence value.

## Technologies

- **React + TypeScript**
- **Deck.GL** for hexagon layers
- **MapLibre GL** for the basemap
- **D3.js** for color scaling and chart rendering
- **Loaders.gl** for CSV file loading
- **Vite** for fast development and builds

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/tcreed880/cropmap.git
cd cropmap/cropmap-frontend
npm install
```

Run a local dev server, build for production, and deploy to GitHub Pages:

```bash
npm run dev

npm run build

npm run deploy
```