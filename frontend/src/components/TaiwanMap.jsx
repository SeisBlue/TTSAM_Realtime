import { useEffect } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, Polyline } from 'react-leaflet'
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

function TaiwanMap({ stations }) {
  // 台灣中心座標
  const center = [23.5, 121.0]
  const zoom = 7

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

  return (
    <div className="taiwan-map-container">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%', background: '#0a0e27' }}
        zoomControl={true}
        attributionControl={false}
      >
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
      </MapContainer>

      {/* 圖例 */}
      <div className="map-legend">
        <div className="legend-title">測站狀態</div>
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
      </div>
    </div>
  )
}

export default TaiwanMap

