import { useState, useEffect, useRef, useMemo, memo } from 'react'
import PropTypes from 'prop-types'
import DeckGL from '@deck.gl/react'
import { OrthographicView } from '@deck.gl/core'
import { PathLayer, TextLayer } from '@deck.gl/layers'
import './RealtimeWaveform.css'

// 所有測站列表 - 按緯度排列顯示
const ALL_STATIONS = [
  'NOU', 'TIPB', 'ILA', 'TWC', 'ENT',
  'HWA', 'EGFH', 'EYUL', 'TTN', 'ECS', 'TAWH', 'HEN',
  'TAP', 'A024', 'NTS', 'NTY', 'NCU', 'B011',
  'HSN1', 'HSN', 'NJD', 'B131', 'TWQ1', 'B045',
  'TCU', 'WDJ', 'WHP', 'WNT1', 'WPL', 'WHY',
  'WCHH', 'WYL', 'WDL', 'WSL', 'CHY1', 'C095', 'WCKO',
  'TAI', 'C015', 'CHN1', 'KAU', 'SCS', 'SPT', 'SSD',
  'PNG', 'KNM', 'MSU'
]

const LAT_MAX = 25.4
const LAT_MIN = 21.8 // 涵蓋整個台灣（包括離島）

// 時間軸設定
const TIME_WINDOW = 30 // 顯示 30 秒的數據
const SAMPLE_RATE = 100 // 100 Hz

/**
 * 檢查測站是否為 TSMIP 格式 (Axxx, Bxxx, Cxxx)
 */
function isTSMIPStation(stationCode) {
  return /^[ABCDEFGH]\d{3}$/.test(stationCode)
}

/**
 * 從 SEED 格式提取測站代碼
 */
function extractStationCode(seedName) {
  if (!seedName) return seedName
  const parts = seedName.split('.')
  if (parts.length >= 2) {
    return parts[1]
  }
  return seedName
}

/**
 * DeckGL 波形面板組件 - 使用 memo 優化
 */
const GeographicWavePanel = memo(function GeographicWavePanel({ title, stations, stationMap, waveDataMap, latMin, latMax, simpleLayout, panelWidth, panelHeight, renderTrigger }) {
  const [hoveredStation] = useState(null) // TODO: Implement hover interaction

  const minLat = latMin ?? LAT_MIN
  const maxLat = latMax ?? LAT_MAX

  // 計算波形路徑數據（使用 PathLayer）- 優化版本
  const waveformLayers = useMemo(() => {
    const waveWidth = panelWidth * 0.75
    const waveHeight = simpleLayout ? 60 : 45 // 增加波形高度：從 40/30 增加到 60/45
    const xOffset = panelWidth * 0.15
    const now = Date.now() // 使用靜態時間點，避免依賴 currentTime
    const bottomMargin = 60  // 為時間軸留出底部空間

    // 預計算所有測站的 Y 位置
    const stationPositions = new Map()
    stations.forEach((stationCode, index) => {
      const station = stationMap[stationCode]
      if (!station) return

      let centerY
      if (simpleLayout) {
        const stationSpacing = waveHeight * 1.0
        const topMargin = waveHeight * 1.0
        const totalStationsHeight = stationSpacing * (stations.length - 1)
        const availableBottomMargin = panelHeight - bottomMargin - topMargin - totalStationsHeight
        const adjustedTopMargin = availableBottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
        centerY = adjustedTopMargin + stationSpacing * index
      } else {
        if (!station.latitude) return
        // 調整為可用高度（扣除底部時間軸空間）
        const availableHeight = panelHeight - bottomMargin
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * availableHeight
      }
      stationPositions.set(stationCode, centerY)
    })

    // 合併所有基線到單個數據集
    const baselineData = []
    const waveformData = []

    stations.forEach((stationCode) => {
      const centerY = stationPositions.get(stationCode)
      if (centerY === undefined) return

      const isHovered = hoveredStation === stationCode
      const waveData = waveDataMap[stationCode]

      // 添加基線
      baselineData.push({
        path: [[xOffset, centerY], [xOffset + waveWidth, centerY]],
        color: isHovered ? [255, 193, 7, 76] : [255, 255, 255, 26],
        width: isHovered ? 1 : 0.5
      })

      // 處理波形數據
      if (waveData?.dataPoints?.length > 0) {
        const displayScale = waveData.displayScale || 1.0

        waveData.dataPoints.forEach(point => {
          const { timestamp, endTimestamp, values, samprate, isGap } = point

          // 跳過斷點標記
          if (isGap) {
            // 可以選擇在這裡繪製斷點指示器（未來功能）
            return
          }

          const timeDiff = now - timestamp
          const endTimeDiff = endTimestamp ? now - endTimestamp : timeDiff

          // 如果整個數據段都在時間窗口之外，跳過
          if (endTimeDiff > TIME_WINDOW * 1000 || timeDiff < 0) return

          const pathPoints = []

          // 使用實際的採樣率和時間戳
          const effectiveSamprate = samprate || SAMPLE_RATE
          const len = values.length

          // 優化：使用 for 循環代替 forEach，減少函數調用開銷
          for (let idx = 0; idx < len; idx++) {
            // 計算這個樣本點的實際時間
            const sampleTime = timestamp + (idx / effectiveSamprate) * 1000  // 毫秒
            const sampleTimeDiff = now - sampleTime
            const sampleTimeOffset = sampleTimeDiff / 1000  // 轉換為秒

            if (sampleTimeOffset < 0 || sampleTimeOffset > TIME_WINDOW) continue

            const x = xOffset + waveWidth * (1 - sampleTimeOffset / TIME_WINDOW)
            const normalizedValue = values[idx] / displayScale
            const clampedValue = Math.max(-1, Math.min(1, normalizedValue))
            const y = centerY - clampedValue * (waveHeight / 2)

            pathPoints.push([x, y])
          }

          if (pathPoints.length > 1) {
            waveformData.push({
              path: pathPoints,
              color: isHovered ? [255, 193, 7, 255] : [76, 175, 80, 230],
              width: isHovered ? 2.0 : 1.2
            })
          }
        })
      }
    })

    // 使用單個 PathLayer 繪製所有基線
    const layers = []

    console.log(`[Wave Debug ${title}] Baselines: ${baselineData.length}, Waveforms: ${waveformData.length}`)
    console.log(`[Wave Debug ${title}] Panel size: ${panelWidth}x${panelHeight}`)
    if (waveformData.length > 0) {
      console.log(`[Wave Debug ${title}] First waveform path length:`, waveformData[0].path.length)
      console.log(`[Wave Debug ${title}] First waveform sample points:`, waveformData[0].path.slice(0, 3))
    }

    if (baselineData.length > 0) {
      layers.push(new PathLayer({
        id: 'baselines',
        data: baselineData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 0.5,
        getDashArray: [3, 3],
        updateTriggers: {
          getColor: hoveredStation,
          getWidth: hoveredStation
        }
      }))
    }

    // 使用單個 PathLayer 繪製所有波形
    if (waveformData.length > 0) {
      layers.push(new PathLayer({
        id: 'waveforms',
        data: waveformData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1.2,
        jointRounded: false, // 關閉圓角以提升性能
        capRounded: false,
        updateTriggers: {
          getColor: hoveredStation,
          getWidth: hoveredStation,
          getPath: waveDataMap // 當波形數據變化時更新
        }
      }))
    }

    return layers
  }, [stations, stationMap, waveDataMap, hoveredStation, minLat, maxLat, simpleLayout, panelWidth, panelHeight, renderTrigger])

  // 文字標籤圖層 - 優化版本
  const labelLayers = useMemo(() => {
    const waveWidth = panelWidth * 0.75
    const waveHeight = simpleLayout ? 60 : 45 // 增加波形高度：從 40/30 增加到 60/45
    const xOffset = panelWidth * 0.15
    const bottomMargin = 60  // 為時間軸留出底部空間

    const labels = []

    stations.forEach((stationCode, index) => {
      const station = stationMap[stationCode]
      if (!station) return

      // 計算 Y 位置
      let centerY
      if (simpleLayout) {
        const stationSpacing = waveHeight * 1.0
        const topMargin = waveHeight * 1.0
        const totalStationsHeight = stationSpacing * (stations.length - 1)
        const availableBottomMargin = panelHeight - bottomMargin - topMargin - totalStationsHeight
        const adjustedTopMargin = availableBottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
        centerY = adjustedTopMargin + stationSpacing * index
      } else {
        if (!station.latitude) return
        // 調整為可用高度（扣除底部時間軸空間）
        const availableHeight = panelHeight - bottomMargin
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * availableHeight
      }

      const waveData = waveDataMap[stationCode]
      const isHovered = hoveredStation === stationCode

      // 測站代碼標籤
      labels.push({
        position: [xOffset - 8, centerY],
        text: stationCode,
        color: isHovered ? [255, 193, 7] : (waveData ? [224, 224, 224] : [102, 102, 102]),
        size: isHovered ? 11 : 10,
        anchor: 'end',
        alignmentBaseline: 'center'
      })

      // 測站中文名稱
      if (station.station_zh) {
        labels.push({
          position: [xOffset + waveWidth + 5, centerY - 8],
          text: station.station_zh,
          color: isHovered ? [255, 193, 7] : [224, 224, 224],
          size: isHovered ? 10 : 9,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }

      // PGA 數值
      if (waveData?.lastPga) {
        labels.push({
          position: [xOffset + waveWidth + 5, centerY + 2],
          text: `PGA: ${waveData.lastPga.toFixed(2)}`,
          color: isHovered ? [255, 193, 7] : [76, 175, 80],
          size: isHovered ? 10 : 9,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }

      // 縮放範圍
      if (waveData?.displayScale) {
        labels.push({
          position: [xOffset + waveWidth + 5, centerY + 11],
          text: `±${waveData.displayScale.toFixed(2)}`,
          color: isHovered ? [255, 193, 7] : [144, 202, 249],
          size: isHovered ? 9 : 8,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }
    })

    // 時間軸標籤 - 顯示實際時間和相對時間差
    const timeAxisY = panelHeight - 50  // 增加底部空間，從 25 改為 50
    const timeWaveWidth = panelWidth * 0.75
    const timeXOffset = panelWidth * 0.15
    const numTicks = 7
    const now = new Date()

    for (let i = 0; i < numTicks; i++) {
      const timeValue = -i * (TIME_WINDOW / (numTicks - 1))
      const x = timeXOffset + timeWaveWidth - (i / (numTicks - 1)) * timeWaveWidth

      let label
      let color
      if (timeValue === 0) {
        // 最右側：顯示當前實際時間（時:分:秒）
        label = now.toLocaleTimeString('zh-TW', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
        color = [76, 175, 80, 255]  // 綠色，完全不透明
      } else {
        // 其他位置：顯示相對時間差
        label = `${timeValue.toFixed(0)}s`
        color = [144, 202, 249, 255]  // 藍色，完全不透明
      }

      labels.push({
        position: [x, timeAxisY + 8],  // 調整文字位置，更靠近軸線
        text: label,
        color: color,
        size: 12,  // 增大字體從 10 到 12
        anchor: 'middle',
        alignmentBaseline: 'center'
      })
    }

    return [new TextLayer({
      id: 'labels',
      data: labels,
      getPosition: d => d.position,
      getText: d => d.text,
      getColor: d => d.color,
      getSize: d => d.size,
      getTextAnchor: d => d.anchor,
      getAlignmentBaseline: d => d.alignmentBaseline,
      fontFamily: 'monospace',
      fontWeight: 'normal',
      updateTriggers: {
        getColor: [hoveredStation, waveDataMap],
        getSize: hoveredStation,
        getText: [waveDataMap, renderTrigger] // 添加 renderTrigger 以更新時間顯示
      }
    })]
  }, [stations, stationMap, waveDataMap, hoveredStation, minLat, maxLat, simpleLayout, panelWidth, panelHeight, renderTrigger])

  // 緯度網格線
  const gridLayers = useMemo(() => {
    if (simpleLayout) return []

    const layers = []
    const gridLines = []
    const gridLabels = []

    for (let lat = Math.ceil(minLat); lat <= maxLat; lat += 0.5) {
      const y = ((maxLat - lat) / (maxLat - minLat)) * panelHeight

      gridLines.push({
        path: [[0, y], [panelWidth, y]],
        color: lat % 1 === 0 ? [100, 181, 246, 76] : [100, 181, 246, 38]
      })

      if (lat % 1 === 0) {
        gridLabels.push({
          position: [8, y - 5],
          text: `${lat}°N`,
          color: [100, 181, 246],
          size: 11
        })
      }
    }

    layers.push(new PathLayer({
      id: 'grid-lines',
      data: gridLines,
      getPath: d => d.path,
      getColor: d => d.color,
      widthMinPixels: 1
    }))

    layers.push(new TextLayer({
      id: 'grid-labels',
      data: gridLabels,
      getPosition: d => d.position,
      getText: d => d.text,
      getColor: d => d.color,
      getSize: d => d.size,
      fontFamily: 'monospace'
    }))

    return layers
  }, [minLat, maxLat, simpleLayout, panelWidth, panelHeight])

  // 時間軸線
  const timeAxisLayer = useMemo(() => {
    const timeAxisY = panelHeight - 50  // 與標籤位置一致，從 25 改為 50
    const axisWaveWidth = panelWidth * 0.75
    const axisXOffset = panelWidth * 0.15

    const lines = [{
      path: [[axisXOffset, timeAxisY], [axisXOffset + axisWaveWidth, timeAxisY]],
      color: [255, 255, 255, 128]  // 增加不透明度，更清晰
    }]

    const numTicks = 7
    for (let i = 0; i < numTicks; i++) {
      const x = axisXOffset + axisWaveWidth - (i / (numTicks - 1)) * axisWaveWidth
      lines.push({
        path: [[x, timeAxisY - 5], [x, timeAxisY + 5]],  // 刻度線更長，從 5 改為 ±5
        color: [255, 255, 255, 128]
      })
    }

    return new PathLayer({
      id: 'time-axis',
      data: lines,
      getPath: d => d.path,
      getColor: d => d.color,
      widthMinPixels: 1.5  // 增加線條寬度
    })
  }, [panelWidth, panelHeight])

  const allLayers = [...gridLayers, timeAxisLayer, ...waveformLayers, ...labelLayers]

  const views = new OrthographicView({
    id: 'ortho',
    controller: false
  })

  // 確保尺寸有效
  const validWidth = Math.max(panelWidth, 100)
  const validHeight = Math.max(panelHeight, 100)

  console.log(`[DeckGL ${title}] Rendering with size: ${validWidth}x${validHeight}, Layers: ${allLayers.length}`)

  // 使用左上角为原点的坐标系统
  const viewState = {
    target: [validWidth / 2, validHeight / 2, 0],
    zoom: 0
  }

  return (
    <div className="geographic-wave-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{stations.length} 站</span>
      </div>
      <div className="deckgl-container" style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0e27' }}>
        {validWidth > 0 && validHeight > 0 ? (
          <DeckGL
            views={views}
            viewState={viewState}
            layers={allLayers}
            width={validWidth}
            height={validHeight}
            controller={false}
            getCursor={() => 'default'}
          />
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'rgba(255, 255, 255, 0.5)',
            fontSize: '14px'
          }}>
            等待容器尺寸...
          </div>
        )}
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // 自定義比較函數：只在關鍵屬性變化時重新渲染
  return (
    prevProps.title === nextProps.title &&
    prevProps.stations === nextProps.stations &&
    prevProps.stationMap === nextProps.stationMap &&
    prevProps.waveDataMap === nextProps.waveDataMap &&
    prevProps.latMin === nextProps.latMin &&
    prevProps.latMax === nextProps.latMax &&
    prevProps.simpleLayout === nextProps.simpleLayout &&
    prevProps.panelWidth === nextProps.panelWidth &&
    prevProps.panelHeight === nextProps.panelHeight
    // 注意：不比較 currentTime，因為它會在 useMemo 內部使用 Date.now()
  )
})

GeographicWavePanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  simpleLayout: PropTypes.bool,
  panelWidth: PropTypes.number.isRequired,
  panelHeight: PropTypes.number.isRequired,
  renderTrigger: PropTypes.number
}

function RealtimeWaveformDeck({ wavePackets, socket, onReplacementUpdate }) {
  const [stationMap, setStationMap] = useState({})
  const [waveDataMap, setWaveDataMap] = useState({})
  const [useNearestTSMIP, setUseNearestTSMIP] = useState(false) // 是否啟用自動尋找最近 TSMIP 測站
  const [nearestStationCache, setNearestStationCache] = useState({}) // 緩存最近測站的映射
  const [renderTrigger, setRenderTrigger] = useState(0) // 添加渲染觸發器
  const panelRef = useRef(null)
  const [dimensions, setDimensions] = useState({
    width: 1200,
    height: 800
  })

  // 建立測站快速查找 Map
  useEffect(() => {
    fetch('http://localhost:5001/api/all-stations')
      .then(response => response.json())
      .then(stations => {
        const map = {}
        stations.forEach(station => {
          map[station.station] = station
        })
        setStationMap(map)
        console.log('📍 [Deck] stationMap updated:', Object.keys(map).length, 'stations')
      })
      .catch(err => {
        console.error('❌ Failed to load all stations:', err)
      })
  }, [])

  // 當啟用自動替換時，為每個 CWASN 測站查找最近的 TSMIP 測站
  useEffect(() => {
    if (!useNearestTSMIP || Object.keys(stationMap).length === 0) {
      setNearestStationCache({})
      return
    }

    const fetchNearestStations = async () => {
      const cache = {}
      const MAX_DISTANCE_KM = 5 // 最大替換距離：5 公里
      const FALLBACK_DISTANCE_KM = 10 // 如果找不到，放寬到 10 公里

      for (const stationCode of ALL_STATIONS) {
        const station = stationMap[stationCode]

        // 如果測站不存在，跳過
        if (!station) {
          continue
        }

        // 如果已經是 TSMIP 格式，跳過
        if (isTSMIPStation(stationCode)) {
          continue
        }

        // 如果沒有經緯度，跳過
        if (!station.latitude || !station.longitude) {
          continue
        }

        try {
          // 先嘗試查找 5 公里內的測站（返回前 5 個候選）
          const response = await fetch(
            `http://localhost:5001/api/find-nearest-station?lat=${station.latitude}&lon=${station.longitude}&exclude_pattern=CWASN&max_count=5`
          )

          if (response.ok) {
            const nearestStations = await response.json()

            if (nearestStations && nearestStations.length > 0) {
              // 優先選擇距離在限制內的測站
              let selectedStation = nearestStations.find(s => s.distance_km <= MAX_DISTANCE_KM)

              // 如果沒有找到足夠近的，嘗試放寬限制
              if (!selectedStation) {
                selectedStation = nearestStations.find(s => s.distance_km <= FALLBACK_DISTANCE_KM)
              }

              // 如果還是沒有，只有在距離合理的情況下才使用最近的
              if (!selectedStation && nearestStations[0].distance_km <= 15) {
                selectedStation = nearestStations[0]
                console.warn(`⚠️ [替換] ${stationCode} 距離較遠: ${nearestStations[0].distance_km} km`)
              }

              if (selectedStation) {
                cache[stationCode] = {
                  originalStation: stationCode,
                  replacementStation: selectedStation.station,
                  distance: selectedStation.distance_km,
                  coordinates: {
                    lat: selectedStation.latitude,
                    lon: selectedStation.longitude
                  }
                }

                const emoji = selectedStation.distance_km <= MAX_DISTANCE_KM ? '✅' :
                             selectedStation.distance_km <= FALLBACK_DISTANCE_KM ? '⚠️' : '❌'
                console.log(`${emoji} [替換] ${stationCode} → ${selectedStation.station} (距離: ${selectedStation.distance_km} km)`)
              } else {
                console.log(`❌ [跳過] ${stationCode}: 最近測站距離過遠 (${nearestStations[0].distance_km} km)`)
              }
            }
          }
        } catch (error) {
          console.error(`❌ 無法為 ${stationCode} 查找最近測站:`, error)
        }
      }

      setNearestStationCache(cache)
      console.log('✅ 最近測站映射已建立:', Object.keys(cache).length, '個替換')

      // 統計距離分佈
      const distances = Object.values(cache).map(r => r.distance)
      if (distances.length > 0) {
        const avgDistance = (distances.reduce((a, b) => a + b, 0) / distances.length).toFixed(2)
        const maxDistance = Math.max(...distances).toFixed(2)
        console.log(`📊 替換距離統計: 平均 ${avgDistance} km, 最大 ${maxDistance} km`)
      }

      // 通知父組件替換信息已更新
      if (onReplacementUpdate) {
        onReplacementUpdate(cache)
      }
    }

    fetchNearestStations()
  }, [useNearestTSMIP, stationMap, onReplacementUpdate])

  // 定期觸發波形更新以實現滾動效果
  useEffect(() => {
    const interval = setInterval(() => {
      setRenderTrigger(prev => prev + 1)
    }, 1000) // 每秒更新一次
    return () => clearInterval(interval)
  }, [])

  // 處理新的波形數據
  useEffect(() => {
    if (wavePackets.length === 0) return

    const latestPacket = wavePackets[0]

    setWaveDataMap(prev => {
      const updated = { ...prev }

      if (latestPacket.data) {
        Object.keys(latestPacket.data).forEach(seedStation => {
          const stationCode = extractStationCode(seedStation)

          if (!updated[stationCode]) {
            updated[stationCode] = {
              dataPoints: [],
              lastPga: 0,
              lastEndTime: null  // 追蹤上一個封包的結束時間
            }
          }

          const stationData = updated[stationCode]
          const wavePacketData = latestPacket.data[seedStation]
          const waveform = wavePacketData?.waveform || []
          const pga = wavePacketData?.pga || 0
          const startt = wavePacketData?.startt  // Earthworm 波形起始時間（秒）
          const endt = wavePacketData?.endt      // Earthworm 波形結束時間（秒）
          const samprate = wavePacketData?.samprate || 100

          // 使用 Earthworm 的實際時間戳，如果沒有則退回到系統時間
          const packetStartTime = startt ? startt * 1000 : Date.now()  // 轉換為毫秒
          const packetEndTime = endt ? endt * 1000 : Date.now()

          // 檢測時間斷點（gap）
          let hasGap = false
          if (stationData.lastEndTime !== null && startt) {
            const timeDiff = Math.abs(startt - stationData.lastEndTime)
            const expectedInterval = 1.0 / samprate  // 預期的時間間隔

            // 如果時間差超過 2 個採樣間隔，視為斷點
            if (timeDiff > expectedInterval * 2) {
              hasGap = true
              console.warn(`⚠️ Time gap detected for ${stationCode}: ${timeDiff.toFixed(3)}s (expected ~${expectedInterval.toFixed(3)}s)`)
            }
          }

          // 如果有斷點，插入一個空數據點來標記斷點
          if (hasGap && stationData.dataPoints.length > 0) {
            stationData.dataPoints.push({
              timestamp: stationData.lastEndTime * 1000,  // 使用上一個封包的結束時間
              endTimestamp: packetStartTime,
              values: [],  // 空數組表示這是一個斷點
              isGap: true
            })
          }

          // 添加新的波形數據點
          stationData.dataPoints.push({
            timestamp: packetStartTime,
            endTimestamp: packetEndTime,
            values: waveform,
            samprate: samprate,
            isGap: false
          })

          // 更新最後的結束時間
          if (endt) {
            stationData.lastEndTime = endt
          }

          // 清理超過時間窗口的數據
          const cutoffTime = Date.now() - TIME_WINDOW * 1000
          stationData.dataPoints = stationData.dataPoints.filter(
            point => point.timestamp >= cutoffTime
          )

          stationData.lastPga = pga

          // 動態縮放（只計算非斷點的數據）
          const recentCutoff = Date.now() - 10 * 1000
          const recentPoints = stationData.dataPoints.filter(
            point => point.timestamp >= recentCutoff && !point.isGap
          )

          if (recentPoints.length > 0) {
            let sumSquares = 0
            let maxAbs = 0
            let count = 0

            recentPoints.forEach(point => {
              point.values.forEach(value => {
                sumSquares += value * value
                maxAbs = Math.max(maxAbs, Math.abs(value))
                count++
              })
            })

            const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0.1
            // 減小 displayScale 使波形振幅更大：rms*8 -> rms*4, maxAbs*0.6 -> maxAbs*0.3
            stationData.displayScale = Math.max(rms * 4, maxAbs * 0.3, 0.05)
            stationData.rms = rms
            stationData.maxAbs = maxAbs
          } else {
            stationData.displayScale = 1.0
            stationData.rms = 0
            stationData.maxAbs = 0
          }
        })
      }

      return updated
    })
  }, [wavePackets])

  // 響應式尺寸計算
  useEffect(() => {
    const updateSize = () => {
      if (panelRef.current) {
        const rect = panelRef.current.getBoundingClientRect()
        setDimensions({
          width: rect.width,
          height: rect.height
        })
      }
    }

    updateSize()
    window.addEventListener('resize', updateSize)

    const resizeObserver = new ResizeObserver(updateSize)
    if (panelRef.current) {
      resizeObserver.observe(panelRef.current)
    }

    return () => {
      window.removeEventListener('resize', updateSize)
      resizeObserver.disconnect()
    }
  }, [])

  // 根據模式動態計算顯示的測站列表
  const displayStations = useMemo(() => {
    if (!useNearestTSMIP || Object.keys(nearestStationCache).length === 0) {
      return ALL_STATIONS
    }

    // 替換模式：將 CWASN 測站替換為最近的 TSMIP 測站
    return ALL_STATIONS.map(stationCode => {
      const replacement = nearestStationCache[stationCode]
      return replacement ? replacement.replacementStation : stationCode
    })
  }, [useNearestTSMIP, nearestStationCache])

  // 自動訂閱當前顯示的測站
  useEffect(() => {
    if (!socket || !socket.connected) {
      console.log('⏳ Socket not ready for subscription')
      return
    }

    // 發送訂閱請求
    socket.emit('subscribe_stations', {
      stations: displayStations
    })

    console.log('📡 Subscribed to', displayStations.length, 'stations:', displayStations.slice(0, 10), '...')

    // 清理函數：組件卸載時取消訂閱
    return () => {
      if (socket && socket.connected) {
        socket.emit('subscribe_stations', { stations: [] })
        console.log('📡 Unsubscribed from all stations')
      }
    }
  }, [socket, displayStations])

  return (
    <div className="realtime-waveform geographic">
      <div className="waveform-controls" style={{
        padding: '10px 20px',
        background: 'rgba(255, 255, 255, 0.05)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        display: 'flex',
        alignItems: 'center',
        gap: '15px'
      }}>
        <button
          onClick={() => setUseNearestTSMIP(!useNearestTSMIP)}
          style={{
            padding: '8px 16px',
            background: useNearestTSMIP ? '#4CAF50' : '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'all 0.3s ease',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
          }}
          onMouseEnter={(e) => {
            e.target.style.transform = 'translateY(-1px)'
            e.target.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)'
          }}
          onMouseLeave={(e) => {
            e.target.style.transform = 'translateY(0)'
            e.target.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)'
          }}
        >
          {useNearestTSMIP ? '✅ 智能替換已啟用' : '🔄 啟用智能替換'}
        </button>
        <span style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '13px' }}>
          {useNearestTSMIP
            ? `自動替換為 5km 內最近的 TSMIP 測站 (已替換 ${Object.keys(nearestStationCache).length} 個測站)`
            : '使用原始 CWASN 測站配置'}
        </span>
      </div>
      <div ref={panelRef} className="waveform-panel-container" style={{ flex: 1, overflow: 'hidden' }}>
        <GeographicWavePanel
          title={`全台測站 ${useNearestTSMIP ? '(智能替換)' : ''}`}
          stations={displayStations}
          stationMap={stationMap}
          waveDataMap={waveDataMap}
          latMin={LAT_MIN}
          latMax={LAT_MAX}
          simpleLayout={false}
          panelWidth={dimensions.width}
          panelHeight={dimensions.height}
          renderTrigger={renderTrigger}
        />
      </div>
    </div>
  )
}

RealtimeWaveformDeck.propTypes = {
  wavePackets: PropTypes.array.isRequired,
  socket: PropTypes.object,
  onReplacementUpdate: PropTypes.func
}

export default RealtimeWaveformDeck

