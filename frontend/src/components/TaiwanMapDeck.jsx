import { useState, useMemo, useEffect } from 'react'
import PropTypes from 'prop-types'
import { Map } from 'react-map-gl/maplibre'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers'
import 'maplibre-gl/dist/maplibre-gl.css'
import './TaiwanMapDeck.css'
// 引入 topojson-client 用於格式轉換
import * as topojson from 'topojson-client'
// 引入台灣縣市的 TopoJSON 地圖資料
import countyData from '../assets/twCounty2010merge.topo.json'

// 使用 MapLibre（開源替代方案，不需要 token）
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const INITIAL_VIEW_STATE = {
  longitude: 121.0,
  latitude: 23.5,
  zoom: 6,
  pitch: 0,
  bearing: 0
}

function TaiwanMapDeck({ stations, stationReplacements = {}, stationIntensities = {}, countyAlerts = {} }) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [hoverInfo, setHoverInfo] = useState(null)
  const [isLegendExpanded, setIsLegendExpanded] = useState(false) // 圖例預設摺疊
  // 新增一個 state 來存放轉換後的 GeoJSON 資料
  const [geojsonData, setGeojsonData] = useState(null)

  // 使用 useEffect 在元件首次載入時，將 TopoJSON 轉換為 GeoJSON
  useEffect(() => {
    // 從 TopoJSON 物件中提取名為 'layer1' 的圖層並轉換
    const geo = topojson.feature(countyData, countyData.objects.layer1)
    setGeojsonData(geo)
  }, []) // 空依賴陣列確保此 effect 只執行一次

  // 建立縣市填色圖層
  const countyLayer = useMemo(() => {
    if (!geojsonData) return null // 如果 GeoJSON 還沒準備好，則不渲染圖層

    return new GeoJsonLayer({
      id: 'county-layer',
      data: geojsonData,
      pickable: false,
      stroked: true, // 顯示縣市邊界
      filled: true,
      lineWidthMinPixels: 1,
      getLineColor: [255, 255, 255, 80], // 縣市邊界顏色（白色，低透明度）
      getFillColor: feature => {
        // 從 GeoJSON 的 properties 中取得縣市名稱
        const countyName = feature.properties.COUNTYNAME
        // 檢查此縣市是否存在於從 App.jsx 傳入的預警列表
        if (countyAlerts[countyName]) {
          // 如果在預警列表中，回傳紅色（帶有透明度）
          return [255, 0, 0, 100]
        }
        // 如果不在預警列表中，則完全透明
        return [0, 0, 0, 0]
      },
      // 當 countyAlerts prop 變動時，觸發 getFillColor 的更新
      updateTriggers: {
        getFillColor: [countyAlerts]
      }
    })
  }, [geojsonData, countyAlerts]) // 當 geojsonData 或 countyAlerts 變動時，重新計算圖層

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
      stroked: true,
      filled: true,
      radiusUnits: 'pixels',
      lineWidthMinPixels: 1,
      getPosition: d => d.coordinates,
      getRadius: d => {
        // 有數據時半徑為 7px，無數據時為 3px
        if (d.intensityData) {
          return 5
        }
        return 3
      },
      getFillColor: d => {
        // 優先使用震度顏色，如果沒有震度數據則使用帶透明度的灰色
        if (d.intensityData && d.intensityData.color) {
          return d.intensityData.color
        }
        // 默認灰色（未知/無數據），增加透明度
        return [148, 163, 184, 90] // #94a3b8 with 90/255 alpha
      },
      getLineColor: d => {
        // 0 級震度顯示灰色邊框
        if (d.intensityData && d.intensityData.intensity === '0') {
          return [176, 176, 176] // var(--gray-30)
        }
        // 其他情況不顯示邊框（透明）
        return [0, 0, 0, 0]
      },
      onHover: info => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getFillColor: [stationIntensities, stationReplacements],
        getLineColor: [stationIntensities],
        getRadius: [stationIntensities], // 新增 getRadius 的 trigger
        getPosition: [stations]
      }
    })
  }, [stations, stationReplacements, stationIntensities])

  const layers = [countyLayer, primaryStationsLayer].filter(Boolean)

  return (
    <div className="taiwan-map-deck-container">
      <DeckGL
        width="100%"
        height="100%"
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
            <div className="tooltip-name">{hoverInfo.object.station_zh || hoverInfo.object.station}</div>
            <div className="tooltip-code">{hoverInfo.object.station}</div>

            {/* 顯示震度信息 */}
            {hoverInfo.object.intensityData && (
              <div className="tooltip-intensity" style={{
                backgroundColor: `rgba(${hoverInfo.object.intensityData.color[0]}, ${hoverInfo.object.intensityData.color[1]}, ${hoverInfo.object.intensityData.color[2]}, 0.3)`
              }}>
                震度: {hoverInfo.object.intensityData.intensity} | PGA: {hoverInfo.object.intensityData.pga.toFixed(2)} gal
              </div>
            )}

            {/* 顯示替換信息（但測站本身在原位置） */}
            {hoverInfo.object.isReplaced && hoverInfo.object.replacementInfo && (
              <div className="tooltip-replacement">
                <div>🔄 數據來源: <strong>{hoverInfo.object.replacementInfo.replacementStation}</strong></div>
                <div className="tooltip-replacement-distance">
                  距離: {hoverInfo.object.replacementInfo.distance.toFixed(2)} km
                </div>
              </div>
            )}

            <div className="tooltip-coords">
              {hoverInfo.object.coordinates[1].toFixed(3)}°N, {hoverInfo.object.coordinates[0].toFixed(3)}°E
            </div>
          </div>
        </div>
      )}

      {/* 圖例 */}
      <div className={`map-legend ${isLegendExpanded ? 'expanded' : 'collapsed'}`}>
        <div
          className="legend-header"
          onClick={() => setIsLegendExpanded(!isLegendExpanded)}
        >
          <span className="legend-header-title">圖例</span>
          <span className="legend-header-arrow">{isLegendExpanded ? '▼' : '▶'}</span>
        </div>

        {isLegendExpanded && (
          <>
            <div className="legend-title">震度分級（30秒最大PGA）</div>
            <div className="legend-item">
              <span className="legend-dot legend-level-0"></span>
              <span>0 級 (&lt;0.8 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-1"></span>
              <span>1 級 (0.8-2.5 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-2"></span>
              <span>2 級 (2.5-8 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-3"></span>
              <span>3 級 (8-25 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-4"></span>
              <span>4 級 (25-80 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-5-minus"></span>
              <span>5- 級 (80-140 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-5-plus"></span>
              <span>5+ 級 (140-250 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-6-minus"></span>
              <span>6- 級 (250-440 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-6-plus"></span>
              <span>6+ 級 (440-800 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-7"></span>
              <span>7 級 (&gt;800 gal)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot legend-level-unknown"></span>
              <span>未知/無數據</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

TaiwanMapDeck.propTypes = {
  stations: PropTypes.array.isRequired,
  stationReplacements: PropTypes.object,
  stationIntensities: PropTypes.object,
  countyAlerts: PropTypes.object
}

export default TaiwanMapDeck