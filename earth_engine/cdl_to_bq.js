// =============================================================
//  Multi-year pulse-crop area & mean confidence by H3 hex (2022–2023)
//  Author: Tim Creed; Project: agmap-474117
//  Notes:
//   • Only uses pixels where (CDL == pulse crop) AND (confidence > 0)
//   • Area now in hectares (1 ha = 10,000 m²)
//   • Exports geometry-free table for deck.gl H3HexagonLayer
//   • Drops 'geo' and 'system:index' columns
// =============================================================

// --- PARAMETERS ---
var h3 = ee.FeatureCollection('projects/agmap-474117/assets/h3_res4_conus_shp');
var years = ee.List.sequence(2008, 2023);
var pulseCodes = [42, 51, 52, 53];  // Dry Beans, Chick Peas, Lentils, Peas

// --- MAIN FUNCTION ---
var computeYear = function(y) {
  y = ee.Number(y);

  var cdlImage = ee.ImageCollection('USDA/NASS/CDL')
    .filterDate(ee.Date.fromYMD(y, 1, 1), ee.Date.fromYMD(y.add(1), 1, 1))
    .first();

  return ee.Algorithms.If(
    cdlImage,
    ee.FeatureCollection(function() {
      cdlImage = ee.Image(cdlImage).select(['cropland', 'confidence']);

      // --- BUILD MULTI-BAND IMAGE ---
      var pulseBands = pulseCodes.map(function(code) {
        var codeStr = code.toString();
        var cropBand = cdlImage.select('cropland');
        var confBand = cdlImage.select('confidence');

        // Mask: pulse crop + valid confidence (>0)
        var cropMask = cropBand.eq(ee.Number(code));
        var validMask = confBand.gt(0);
        var finalMask = cropMask.and(validMask);

        // Convert pixel area to hectares
        var area_ha = ee.Image.pixelArea()
          .divide(10000)
          .updateMask(finalMask)
          .rename('area_' + codeStr);

        // Weighted confidence (confidence × area in ha)
        var confWeighted = confBand
          .updateMask(finalMask)
          .multiply(ee.Image.pixelArea().divide(10000))
          .rename('confw_' + codeStr);

        return ee.Image.cat([area_ha, confWeighted]);
      });

      var pulseStack = ee.Image.cat(pulseBands);

      // --- REDUCE OVER H3 GRID ---
      var reduced = pulseStack.reduceRegions({
        collection: h3,
        reducer: ee.Reducer.sum(),
        scale: 30
      });

      // --- FLATTEN TO LONG FORMAT ---
      var long = reduced.map(function(f) {
        var dict = f.toDictionary();
        var props = pulseCodes.map(function(code) {
          var keyA = 'area_' + code.toString();
          var keyC = 'confw_' + code.toString();
          var area = ee.Number(dict.get(keyA, 0));
          var confWeighted = ee.Number(dict.get(keyC, 0));

          var meanConf = ee.Algorithms.If(
            area.gt(0),
            confWeighted.divide(area),
            ee.Number(0)
          );

          // Create geometry-free feature (no 'geo' column)
          return ee.Feature(null, {
            'h3_id': f.get('h3'),
            'year': y.int(),
            'crop_id': code,
            'area_ha': area,                  // hectares
            'mean_confidence': meanConf
          });
        });
        return ee.FeatureCollection(props);
      }).flatten();

      // Filter out empty results & explicitly select fields to keep
      var clean = long.filter(ee.Filter.gt('area_ha', 0))
                      .select(['h3_id', 'year', 'crop_id', 'area_ha', 'mean_confidence'], null, false);

      return clean;
    }()),
    ee.FeatureCollection([]) // Empty fallback if CDL not found
  );
};

// --- APPLY FUNCTION TO ALL YEARS ---
var allYears = ee.FeatureCollection(years.map(computeYear)).flatten();

// --- PREVIEW GRID ---
Map.addLayer(h3, {}, 'H3 Grid');

// --- EXPORT TO BIGQUERY ---
Export.table.toBigQuery({
  collection: allYears,
  description: 'pulse_area_conf_valid_by_h3_2008_2023_ha',
  table: 'agmap-474117.geo.pulse_conus_2008_2023_ha',
  selectors: ['h3_id', 'year', 'crop_id', 'area_ha', 'mean_confidence']  // explicit columns
});
