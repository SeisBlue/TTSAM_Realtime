import { useState, useEffect, useMemo, useCallback } from 'react'
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

function TaiwanMapDeck({ stations, onStationSelect, stationReplacements = {} }) {
  const [allStations, setAllStations] = useState([])
  const [selectedStations, setSelectedStations] = useState(new Set())
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [hoverInfo, setHoverInfo] = useState(null)

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

  // 處理測站點擊
  const handleStationClick = useCallback((info) => {
    if (!info.object) return

    const stationCode = info.object.station
    const newSelected = new Set(selectedStations)

    if (newSelected.has(stationCode)) {
      newSelected.delete(stationCode)
    } else {
      newSelected.add(stationCode)
    }

    setSelectedStations(newSelected)

    if (onStationSelect) {
      onStationSelect(Array.from(newSelected))
    }
  }, [selectedStations, onStationSelect])

  // 主要測站圖層（eew_target）
  const primaryStationsLayer = useMemo(() => {
    const data = stations.map(s => {
      const replacement = stationReplacements[s.station]

      // 如果有替換，使用替換後的座標
      const coordinates = replacement
        ? [replacement.coordinates.lon, replacement.coordinates.lat]
        : [s.longitude, s.latitude]

      return {
        ...s,
        coordinates,
        isReplaced: !!replacement,
        replacementInfo: replacement
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
        // 如果是替換的測站，使用特殊顏色（紫色）
        if (d.isReplaced) {
          return [168, 85, 247] // #a855f7 紫色表示替換
        }

        // 根據狀態決定顏色
        switch (d.status) {
          case 'online': return [34, 197, 94]  // #22c55e
          case 'warning': return [245, 158, 11] // #f59e0b
          case 'offline': return [239, 68, 68]  // #ef4444
          default: return [148, 163, 184]       // #94a3b8
        }
      },
      getLineColor: d => d.isReplaced ? [168, 85, 247] : [255, 255, 255],
      onClick: handleStationClick,
      onHover: info => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getFillColor: [stations, stationReplacements],
        getLineColor: [stationReplacements],
        getPosition: [stationReplacements]
      }
    })
  }, [stations, stationReplacements, handleStationClick])

  // 次要測站圖層（TSMIP）
  const secondaryStationsLayer = useMemo(() => {
    const data = allStations.map(s => ({
      ...s,
      coordinates: [s.longitude, s.latitude],
      isSecondary: true,
      isSelected: selectedStations.has(s.station)
    }))

    return new ScatterplotLayer({
      id: 'secondary-stations',
      data,
      pickable: true,
      opacity: 0.8,
      stroked: true,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 3,
      radiusMaxPixels: 5,
      lineWidthMinPixels: 1,
      getPosition: d => d.coordinates,
      getFillColor: d => {
        // 選中：黃色，未選中：灰色
        return d.isSelected ? [255, 193, 7] : [102, 102, 102]
      },
      getLineColor: [255, 255, 255],
      onClick: handleStationClick,
      onHover: info => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getFillColor: [selectedStations],
        getData: [allStations]
      }
    })
  }, [allStations, selectedStations, handleStationClick])

  const layers = [secondaryStationsLayer, primaryStationsLayer]

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
            {hoverInfo.object.isPrimary || hoverInfo.object.station_zh ? (
              <>
                <div className="tooltip-name">{hoverInfo.object.station_zh || hoverInfo.object.station}</div>
                <div className="tooltip-code">{hoverInfo.object.station}</div>

                {/* 顯示替換信息 */}
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
              <>
                <div className="tooltip-code">{hoverInfo.object.station}</div>
                <div className="tooltip-coords">
                  {hoverInfo.object.latitude.toFixed(3)}°N, {hoverInfo.object.longitude.toFixed(3)}°E
                </div>
                {hoverInfo.object.isSelected && (
                  <div className="tooltip-status" style={{ color: '#ffc107' }}>已選中</div>
                )}
                <div className="tooltip-hint">點擊加入測試群組</div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 選中的測站列表面板 */}
      {selectedStations.size > 0 && (
        <div className="selected-stations-panel">
          <h4>測試群組 ({selectedStations.size})</h4>
          <div className="selected-stations-list">
            {Array.from(selectedStations).map(station => (
              <span
                key={station}
                className="selected-station-tag"
                onClick={() => {
                  const newSelected = new Set(selectedStations)
                  newSelected.delete(station)
                  setSelectedStations(newSelected)
                  if (onStationSelect) onStationSelect(Array.from(newSelected))
                }}
              >
                {station} ×
              </span>
            ))}
          </div>
          <button
            className="clear-selection-btn"
            onClick={() => {
              setSelectedStations(new Set())
              if (onStationSelect) onStationSelect([])
            }}
          >
            清空
          </button>
        </div>
      )}

      {/* 圖例 */}
      <div className="map-legend">
        <div className="legend-title">主要測站</div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#a855f7' }}></span>
          <span>已替換 (顯示替換後位置)</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#22c55e' }}></span>
          <span>正常</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#f59e0b' }}></span>
          <span>延遲</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#ef4444' }}></span>
          <span>掉線</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#94a3b8' }}></span>
          <span>未知</span>
        </div>

        <div className="legend-divider"></div>

        <div className="legend-title">次要測站（TSMIP）</div>
        <div className="legend-item">
          <span className="legend-dot small" style={{ backgroundColor: '#ffc107' }}></span>
          <span>已選中</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot small" style={{ backgroundColor: '#666' }}></span>
          <span>未選中</span>
        </div>
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
  onStationSelect: PropTypes.func,
  stationReplacements: PropTypes.object
}

export default TaiwanMapDeck

