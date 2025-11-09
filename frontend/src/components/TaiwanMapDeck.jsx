import { useState, useEffect, useMemo } from 'react'
import PropTypes from 'prop-types'
import { Map } from 'react-map-gl/maplibre'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import 'maplibre-gl/dist/maplibre-gl.css'
import './TaiwanMapDeck.css'

// 使用 MapLibre（開源替代方案，不需要 token）
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const INITIAL_VIEW_STATE = {
  longitude: 121.0,
  latitude: 23.5,
  zoom: 6,
  pitch: 0,
  bearing: 0
}

function TaiwanMapDeck({ stations, stationReplacements = {}, stationIntensities = {} }) {
  const [allStations, setAllStations] = useState([])
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [hoverInfo, setHoverInfo] = useState(null)
  const [isLegendExpanded, setIsLegendExpanded] = useState(false) // 圖例預設摺疊

  // 載入所有測站資料（從後端 API）
  useEffect(() => {
    fetch('http://localhost:5001/api/all-stations')
      .then(response => response.json())
      .then(stations => {
        // 去重：每個測站代碼只保留第一筆記錄
        const uniqueStations = new Map()
        stations.forEach(s => {
          if (!uniqueStations.has(s.station)) {
            uniqueStations.set(s.station, {
              ...s,
              isSecondary: true
            })
          }
        })

        const deduplicatedStations = Array.from(uniqueStations.values())
        setAllStations(deduplicatedStations)
        console.log(`📍 Deck.gl: Loaded ${deduplicatedStations.length} unique secondary stations`)
      })
      .catch(err => {
        console.error('❌ Failed to load secondary stations:', err)
        setAllStations([])
      })
  }, [])


  // 主要測站圖層（eew_target）
  const primaryStationsLayer = useMemo(() => {
    const data = stations.map(s => {
      const replacement = stationReplacements[s.station]

      // 獲取震度數據（優先使用替換測站的數據）
      const stationCodeForIntensity = replacement ? replacement.replacementStation : s.station
      const intensityData = stationIntensities[stationCodeForIntensity]

      // 統一使用原始座標顯示測站
      const coordinates = [s.longitude, s.latitude]

      return {
        ...s,
        coordinates,
        isReplaced: !!replacement,
        replacementInfo: replacement,
        replacementCoordinates: replacement
          ? [replacement.coordinates.lon, replacement.coordinates.lat]
          : null,
        intensityData: intensityData // 添加震度數據
      }
    })

    return new ScatterplotLayer({
      id: 'primary-stations',
      data,
      pickable: true,
      opacity: 1,
      stroked: true,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 5,
      radiusMaxPixels: 8,
      lineWidthMinPixels: 2,
      getPosition: d => d.coordinates,
      getFillColor: d => {
        // 優先使用震度顏色，如果沒有震度數據則使用灰色
        if (d.intensityData && d.intensityData.color) {
          return d.intensityData.color
        }
        // 默認灰色（未知/無數據）
        return [148, 163, 184] // #94a3b8
      },
      getLineColor: [255, 255, 255],
      onHover: info => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getFillColor: [stationIntensities, stationReplacements],
        getPosition: [stations]
      }
    })
  }, [stations, stationReplacements, stationIntensities])

  // 次要測站圖層（TSMIP）
  const secondaryStationsLayer = useMemo(() => {
    const data = allStations.map(s => ({
      ...s,
      coordinates: [s.longitude, s.latitude],
      isSecondary: true
    }))

    return new ScatterplotLayer({
      id: 'secondary-stations',
      data,
      pickable: true,
      opacity: 0.6,
      stroked: true,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 3,
      radiusMaxPixels: 5,
      lineWidthMinPixels: 1,
      getPosition: d => d.coordinates,
      getFillColor: [102, 102, 102], // 統一灰色
      getLineColor: [255, 255, 255],
      onHover: info => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getData: [allStations]
      }
    })
  }, [allStations])

  // 替換測站圖層（只在啟用智能替換時顯示）
  const replacementStationsLayer = useMemo(() => {
    // 過濾出有替換的測站
    const replacedStations = stations
      .filter(s => stationReplacements[s.station])
      .map(s => {
        const replacement = stationReplacements[s.station]
        const replacementStationCode = replacement.replacementStation
        const intensityData = stationIntensities[replacementStationCode]

        return {
          ...s,
          station: replacementStationCode, // 顯示替換後的測站代碼
          coordinates: [replacement.coordinates.lon, replacement.coordinates.lat],
          isReplacedStation: true,
          originalStation: s.station,
          replacementInfo: replacement,
          intensityData: intensityData
        }
      })

    // 如果沒有替換的測站，返回 null
    if (replacedStations.length === 0) {
      return null
    }

    return new ScatterplotLayer({
      id: 'replacement-stations',
      data: replacedStations,
      pickable: true,
      opacity: 1,
      stroked: true,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 6,
      radiusMaxPixels: 10,
      lineWidthMinPixels: 2,
      getPosition: d => d.coordinates,
      getFillColor: d => {
        // 使用震度顏色，如果沒有則使用紫色
        if (d.intensityData && d.intensityData.color) {
          return d.intensityData.color
        }
        return [168, 85, 247] // #a855f7 紫色（無數據時）
      },
      getLineColor: [168, 85, 247, 200],
      onHover: info => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getData: [stationReplacements],
        getFillColor: [stationIntensities]
      }
    })
  }, [stations, stationReplacements, stationIntensities])

  const layers = [secondaryStationsLayer, primaryStationsLayer, replacementStationsLayer].filter(Boolean)

  return (
    <div className="taiwan-map-deck-container">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        controller={true}
        layers={layers}
      >
        <Map
          mapStyle={MAP_STYLE}
        />
      </DeckGL>

      {/* Hover Tooltip */}
      {hoverInfo && hoverInfo.object && (
        <div
          className="deck-tooltip"
          style={{
            left: hoverInfo.x,
            top: hoverInfo.y
          }}
        >
          <div className="tooltip-content">
            {hoverInfo.object.isReplacedStation ? (
              // 替換測站（紫色）的 tooltip
              <>
                <div className="tooltip-name" style={{ color: '#a855f7' }}>
                  🔄 {hoverInfo.object.station}
                </div>
                <div className="tooltip-code" style={{ fontSize: '12px', opacity: 0.8 }}>
                  替換自: {hoverInfo.object.originalStation}
                </div>

                {/* 顯示震度信息 */}
                {hoverInfo.object.intensityData && (
                  <div style={{
                    fontSize: '13px',
                    fontWeight: 'bold',
                    marginTop: '4px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor: `rgba(${hoverInfo.object.intensityData.color[0]}, ${hoverInfo.object.intensityData.color[1]}, ${hoverInfo.object.intensityData.color[2]}, 0.3)`
                  }}>
                    震度: {hoverInfo.object.intensityData.intensity} | PGA: {hoverInfo.object.intensityData.pga.toFixed(2)} gal
                  </div>
                )}

                <div className="tooltip-coords">
                  {hoverInfo.object.coordinates[1].toFixed(3)}°N, {hoverInfo.object.coordinates[0].toFixed(3)}°E
                </div>
                {hoverInfo.object.replacementInfo && (
                  <div style={{ fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>
                    距離: {hoverInfo.object.replacementInfo.distance.toFixed(2)} km
                  </div>
                )}
              </>
            ) : !hoverInfo.object.isSecondary ? (
              // 原始主要測站的 tooltip
              <>
                <div className="tooltip-name">{hoverInfo.object.station_zh || hoverInfo.object.station}</div>
                <div className="tooltip-code">{hoverInfo.object.station}</div>

                {/* 顯示震度信息 */}
                {hoverInfo.object.intensityData && (
                  <div style={{
                    fontSize: '13px',
                    fontWeight: 'bold',
                    marginTop: '4px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor: `rgba(${hoverInfo.object.intensityData.color[0]}, ${hoverInfo.object.intensityData.color[1]}, ${hoverInfo.object.intensityData.color[2]}, 0.3)`
                  }}>
                    震度: {hoverInfo.object.intensityData.intensity} | PGA: {hoverInfo.object.intensityData.pga.toFixed(2)} gal
                  </div>
                )}

                {/* 顯示替換信息（但測站本身在原位置） */}
                {hoverInfo.object.isReplaced && hoverInfo.object.replacementInfo && (
                  <div className="tooltip-replacement" style={{
                    color: '#a855f7',
                    fontSize: '12px',
                    marginTop: '4px',
                    borderTop: '1px solid rgba(168, 85, 247, 0.3)',
                    paddingTop: '4px'
                  }}>
                    <div>🔄 已替換為: <strong>{hoverInfo.object.replacementInfo.replacementStation}</strong></div>
                    <div style={{ fontSize: '11px', opacity: 0.8 }}>
                      距離: {hoverInfo.object.replacementInfo.distance.toFixed(2)} km
                    </div>
                  </div>
                )}

                <div className="tooltip-coords">
                  {hoverInfo.object.coordinates[1].toFixed(3)}°N, {hoverInfo.object.coordinates[0].toFixed(3)}°E
                </div>
              </>
            ) : (
              // 次要測站（TSMIP）的 tooltip
              <>
                <div className="tooltip-code">{hoverInfo.object.station}</div>
                <div className="tooltip-coords">
                  {hoverInfo.object.latitude.toFixed(3)}°N, {hoverInfo.object.longitude.toFixed(3)}°E
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 圖例 */}
      <div className={`map-legend ${isLegendExpanded ? 'expanded' : 'collapsed'}`}>
        <div
          className="legend-header"
          onClick={() => setIsLegendExpanded(!isLegendExpanded)}
          style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span style={{ fontWeight: 'bold' }}>圖例</span>
          <span style={{ fontSize: '12px' }}>{isLegendExpanded ? '▼' : '▶'}</span>
        </div>

        {isLegendExpanded && (
          <>
            <div className="legend-title">震度分級（30秒最大PGA）</div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#ffffff', border: '1px solid #ccc' }}></span>
              <span>0 級 (&lt;0.8 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#33FFDD' }}></span>
              <span>1 級 (0.8-2.5 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#34ff32' }}></span>
              <span>2 級 (2.5-8 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#fefd32' }}></span>
              <span>3 級 (8-25 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#fe8532' }}></span>
              <span>4 級 (25-80 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#fd5233' }}></span>
              <span>5- 級 (80-140 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#c43f3b' }}></span>
              <span>5+ 級 (140-250 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#9d4646' }}></span>
              <span>6- 級 (250-440 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#9a4c86' }}></span>
              <span>6+ 級 (440-800 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#b51fea' }}></span>
              <span>7 級 (&gt;800 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: '#94a3b8' }}></span>
              <span>未知/無數據</span>
            </div>

            <div className="legend-divider"></div>

            <div className="legend-title">次要測站（TSMIP）</div>
            <div className="legend-item">
              <span className="legend-dot small" style={{ backgroundColor: '#666' }}></span>
              <span>參考測站</span>
            </div>
          </>
        )}
      </div>

      {/* 性能指示器 */}
      <div className="performance-badge">
        <span>⚡ WebGL 加速</span>
        <span className="station-count">{allStations.length + stations.length} 測站</span>
      </div>
    </div>
  )
}

TaiwanMapDeck.propTypes = {
  stations: PropTypes.array.isRequired,
  stationReplacements: PropTypes.object,
  stationIntensities: PropTypes.object
}

export default TaiwanMapDeck

