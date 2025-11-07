import { useEffect, useState, useMemo } from 'react'
import PropTypes from 'prop-types'
import { MapContainer, TileLayer, CircleMarker, Tooltip, Polyline, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './TaiwanMap.css'

// 修復 Leaflet 預設圖標問題
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

// 監聽地圖縮放層級
function ZoomWatcher({ onZoomChange }) {
  const map = useMapEvents({
    zoomend: () => {
      onZoomChange(map.getZoom())
    }
  })

  useEffect(() => {
    onZoomChange(map.getZoom())
  }, [map, onZoomChange])

  return null
}

function TaiwanMap({ stations, waveDataMap, onStationSelect }) {
  const [allStations, setAllStations] = useState([]) // 從 site_info.csv 載入的所有測站
  const [selectedStations, setSelectedStations] = useState(new Set())
  const [currentZoom, setCurrentZoom] = useState(7)

  // 台灣中心座標
  const center = [23.5, 121.0]
  const zoom = 7

  // 載入所有測站資料（從後端 API）
  useEffect(() => {
    fetch('http://localhost:5001/api/all-stations')
      .then(response => response.json())
      .then(stations => {
        // 去重：每個測站代碼只保留第一筆記錄（同一測站可能有多個通道）
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
        console.log(`📍 Loaded ${deduplicatedStations.length} unique secondary stations (from ${stations.length} total records)`)
      })
      .catch(err => {
        console.error('❌ Failed to load secondary stations from API:', err)
        // 如果後端 API 失敗，可以降級處理（例如只顯示主要測站）
        setAllStations([])
      })
  }, [])

  // 處理次要測站點擊
  const handleSecondaryStationClick = (stationCode) => {
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
  }

  // 狀態顏色
  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return '#22c55e'
      case 'warning': return '#f59e0b'
      case 'offline': return '#ef4444'
      default: return '#94a3b8'
    }
  }

  // 狀態中文
  const getStatusText = (status) => {
    switch (status) {
      case 'online': return '正常'
      case 'warning': return '延遲'
      case 'offline': return '掉線'
      default: return '未知'
    }
  }

  useEffect(() => {
    // 強制 Leaflet 重新計算大小（避免灰色區塊）
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'))
    }, 200)
  }, [])

  // 根據縮放層級過濾次要測站（優化性能）
  const visibleSecondaryStations = useMemo(() => {
    // 縮放層級 < 8：不顯示次要測站
    // 縮放層級 8-9：只顯示有數據或已選中的
    // 縮放層級 >= 10：顯示所有

    if (currentZoom < 8) {
      // 只顯示已選中的測站
      return allStations.filter(s => selectedStations.has(s.station))
    } else if (currentZoom < 10) {
      // 顯示有數據或已選中的測站
      return allStations.filter(s => {
        const hasData = waveDataMap && waveDataMap[s.station]
        const isSelected = selectedStations.has(s.station)
        return hasData || isSelected
      })
    } else {
      // 顯示所有測站
      return allStations
    }
  }, [allStations, currentZoom, waveDataMap, selectedStations])

  return (
    <div className="taiwan-map-container">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%', background: '#0a0e27' }}
        zoomControl={true}
        attributionControl={false}
      >
        {/* 監聽縮放層級 */}
        <ZoomWatcher onZoomChange={setCurrentZoom} />

        {/* 黑白色系地圖圖層 - CartoDB Dark Matter */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        />

        {/* 象限分界線 - 緯度 24.0° (東西向) */}
        <Polyline
          positions={[[24.0, 118.0], [24.0, 122.5]]}
          pathOptions={{
            color: '#64b5f6',
            weight: 2,
            opacity: 0.4,
            dashArray: '10, 10'
          }}
        />

        {/* 象限分界線 - 經度 121.0° (南北向) */}
        <Polyline
          positions={[[21.5, 121.0], [26.5, 121.0]]}
          pathOptions={{
            color: '#64b5f6',
            weight: 2,
            opacity: 0.4,
            dashArray: '10, 10'
          }}
        />

        {/* 測站標記 */}
        {stations.map((station, idx) => {
          if (!station.latitude || !station.longitude) return null

          const color = getStatusColor(station.status)

          return (
            <CircleMarker
              key={idx}
              center={[station.latitude, station.longitude]}
              radius={5}
              pathOptions={{
                fillColor: color,
                fillOpacity: 1,
                color: '#ffffff',
                weight: 2,
                opacity: 1
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -8]}
                opacity={0.95}
                className="station-tooltip-leaflet"
                permanent={false}
              >
                <div className="tooltip-content">
                  <div className="tooltip-header">
                    <span className="tooltip-county">{station.county}</span>
                    <span
                      className="tooltip-status"
                      style={{ backgroundColor: color }}
                    >
                      {getStatusText(station.status)}
                    </span>
                  </div>
                  <div className="tooltip-name">{station.station_zh}</div>
                  <div className="tooltip-code">{station.station}</div>
                  <div className="tooltip-coords">
                    {station.latitude.toFixed(3)}°N, {station.longitude.toFixed(3)}°E
                  </div>
                </div>
              </Tooltip>
            </CircleMarker>
          )
        })}

        {/* 次要測站標記（TSMIP，來自 site_info.csv）- 小圓點 */}
        {visibleSecondaryStations.map((station) => {
          const { station: stationCode, latitude, longitude } = station

          if (!latitude || !longitude) return null

          const hasData = waveDataMap && waveDataMap[stationCode]
          const isSelected = selectedStations.has(stationCode)

          // 根據狀態決定顏色
          let fillColor = '#666' // 預設灰色（無數據）
          if (isSelected) {
            fillColor = '#ffc107' // 選中：黃色
          } else if (hasData) {
            fillColor = '#4caf50' // 有數據：綠色
          }

          return (
            <CircleMarker
              key={`secondary-${stationCode}`}
              center={[latitude, longitude]}
              radius={3} // 小圓點（主要測站是 5）
              pathOptions={{
                fillColor: fillColor,
                fillOpacity: 0.8,
                color: '#ffffff',
                weight: 1,
                opacity: 0.8
              }}
              eventHandlers={{
                click: () => handleSecondaryStationClick(stationCode)
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -5]}
                opacity={0.9}
                className="station-tooltip-leaflet secondary"
                permanent={false}
              >
                <div className="tooltip-content">
                  <div className="tooltip-code">{stationCode}</div>
                  <div className="tooltip-coords">
                    {latitude.toFixed(3)}°N, {longitude.toFixed(3)}°E
                  </div>
                  {hasData && <div className="tooltip-status" style={{ color: '#4caf50' }}>有波型數據</div>}
                  {isSelected && <div className="tooltip-status" style={{ color: '#ffc107' }}>已選中</div>}
                  <div className="tooltip-hint">點擊加入測試群組</div>
                </div>
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>

      {/* 選中的測站列表面板 */}
      {selectedStations.size > 0 && (
        <div className="selected-stations-panel">
          <h4>測試群組 ({selectedStations.size})</h4>
          <div className="selected-stations-list">
            {Array.from(selectedStations).map(station => (
              <span
                key={station}
                className="selected-station-tag"
                onClick={() => handleSecondaryStationClick(station)}
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

      {/* 縮放層級提示 */}
      {currentZoom < 8 && (
        <div className="zoom-hint">
          <span>🔍 放大地圖可查看次要測站</span>
        </div>
      )}
      {currentZoom >= 8 && currentZoom < 10 && (
        <div className="zoom-hint">
          <span>🔍 繼續放大可查看所有測站</span>
          <span className="zoom-hint-detail">
            (目前顯示: {visibleSecondaryStations.length} / {allStations.length})
          </span>
        </div>
      )}

      {/* 圖例 */}
      <div className="map-legend">
        <div className="legend-title">主要測站</div>
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
          <span className="legend-dot small" style={{ backgroundColor: '#4caf50' }}></span>
          <span>有數據</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot small" style={{ backgroundColor: '#ffc107' }}></span>
          <span>已選中</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot small" style={{ backgroundColor: '#666' }}></span>
          <span>無數據</span>
        </div>
      </div>
    </div>
  )
}

TaiwanMap.propTypes = {
  stations: PropTypes.array.isRequired,
  waveDataMap: PropTypes.object,
  onStationSelect: PropTypes.func
}

export default TaiwanMap

