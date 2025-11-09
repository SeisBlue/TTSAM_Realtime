import { useState, useEffect, useRef, useMemo } from 'react'
import PropTypes from 'prop-types'
import DeckGL from '@deck.gl/react'
import { OrthographicView } from '@deck.gl/core'
import { PathLayer, TextLayer } from '@deck.gl/layers'
import './RealtimeWaveform.css'

// 測站分組：東部、西部、離島三組
const STATION_GROUPS = {
  east: {
    title: '東部測站',
    stations: [
      'NOU', 'TIPB', 'ILA', 'TWC', 'ENT',
      'HWA', 'EGFH', 'EYUL', 'TTN', 'ECS', 'TAWH', 'HEN'
    ]
  },
  west: {
    title: '西部測站',
    stations: [
      'TAP', 'A024', 'NTS', 'NTY', 'NCU', 'B011',
      'HSN1', 'HSN', 'NJD', 'B131', 'TWQ1', 'B045',
      'TCU', 'WDJ', 'WHP', 'WNT1', 'WPL', 'WHY',
      'WCHH', 'WYL', 'WDL', 'WSL', 'CHY1', 'C095', 'WCKO',
      'TAI', 'C015', 'CHN1', 'KAU', 'SCS', 'SPT', 'SSD'
    ]
  },
  islands: {
    title: '離島測站',
    stations: ['PNG', 'KNM', 'MSU']
  }
}

const LAT_MAX = 25.4
const EAST_LAT_MIN = 21.2
const EAST_LAT_MAX = 25.4
const ISLANDS_PANEL_HEIGHT = 200
const PANEL_GAP = 8

// 時間軸設定
const TIME_WINDOW = 30 // 顯示 30 秒的數據
const SAMPLE_RATE = 100 // 100 Hz

/**
 * 檢查測站是否為 TSMIP 格式 (Axxx, Bxxx, Cxxx)
 */
function isTSMIPStation(stationCode) {
  return /^[ABC]\d{3}$/.test(stationCode)
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
 * DeckGL 波形面板組件
 */
function GeographicWavePanel({ title, stations, stationMap, waveDataMap, latMin, latMax, simpleLayout, currentTime, panelWidth, panelHeight }) {
  const [hoveredStation] = useState(null) // TODO: Implement hover interaction

  const minLat = latMin ?? EAST_LAT_MIN
  const maxLat = latMax ?? LAT_MAX

  // 計算波形路徑數據（使用 PathLayer）
  const waveformLayers = useMemo(() => {
    const layers = []
    const waveWidth = panelWidth * 0.75
    const waveHeight = simpleLayout ? 40 : 30
    const xOffset = panelWidth * 0.15

    stations.forEach((stationCode, index) => {
      const station = stationMap[stationCode]
      if (!station) return

      // 計算 Y 位置
      let centerY
      if (simpleLayout) {
        const stationSpacing = waveHeight * 1.0
        const topMargin = waveHeight * 1.0
        const totalStationsHeight = stationSpacing * (stations.length - 1)
        const bottomMargin = panelHeight - topMargin - totalStationsHeight
        const adjustedTopMargin = bottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
        centerY = adjustedTopMargin + stationSpacing * index
      } else {
        if (!station.latitude) return
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * panelHeight
      }

      const waveData = waveDataMap[stationCode]
      const isHovered = hoveredStation === stationCode

      // 基線路徑
      layers.push(new PathLayer({
        id: `baseline-${stationCode}`,
        data: [{
          path: [[xOffset, centerY], [xOffset + waveWidth, centerY]],
          color: isHovered ? [255, 193, 7, 76] : [255, 255, 255, 26]
        }],
        getPath: d => d.path,
        getColor: d => d.color,
        widthMinPixels: isHovered ? 1 : 0.5,
        getDashArray: [3, 3]
      }))

      // 波形路徑
      if (waveData && waveData.dataPoints && waveData.dataPoints.length > 0) {
        const displayScale = waveData.displayScale || 1.0
        const paths = []

        waveData.dataPoints.forEach(point => {
          const { timestamp, values } = point
          const timeDiff = currentTime - timestamp

          if (timeDiff < 0 || timeDiff > TIME_WINDOW * 1000) return

          const startTimeOffset = timeDiff / 1000
          const pathPoints = []

          values.forEach((value, idx) => {
            const sampleTimeOffset = startTimeOffset - (idx / SAMPLE_RATE)
            if (sampleTimeOffset < 0 || sampleTimeOffset > TIME_WINDOW) return

            const x = xOffset + waveWidth * (1 - sampleTimeOffset / TIME_WINDOW)
            const normalizedValue = value / displayScale
            const clampedValue = Math.max(-1, Math.min(1, normalizedValue))
            const y = centerY - clampedValue * (waveHeight / 2)

            pathPoints.push([x, y])
          })

          if (pathPoints.length > 1) {
            paths.push({
              path: pathPoints,
              color: isHovered ? [255, 193, 7, 255] : [76, 175, 80, 230]
            })
          }
        })

        if (paths.length > 0) {
          layers.push(new PathLayer({
            id: `waveform-${stationCode}`,
            data: paths,
            getPath: d => d.path,
            getColor: d => d.color,
            widthMinPixels: isHovered ? 2.0 : 1.2,
            jointRounded: true,
            capRounded: true
          }))
        }
      }
    })

    return layers
  }, [stations, stationMap, waveDataMap, currentTime, hoveredStation, minLat, maxLat, simpleLayout, panelWidth, panelHeight])

  // 文字標籤圖層
  const labelLayers = useMemo(() => {
    const layers = []
    const waveWidth = panelWidth * 0.75
    const waveHeight = simpleLayout ? 40 : 30
    const xOffset = panelWidth * 0.15

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
        const bottomMargin = panelHeight - topMargin - totalStationsHeight
        const adjustedTopMargin = bottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
        centerY = adjustedTopMargin + stationSpacing * index
      } else {
        if (!station.latitude) return
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * panelHeight
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

    // 時間軸標籤
    const timeAxisY = panelHeight - 25
    const timeWaveWidth = panelWidth * 0.75
    const timeXOffset = panelWidth * 0.15
    const numTicks = 7

    for (let i = 0; i < numTicks; i++) {
      const timeValue = -i * (TIME_WINDOW / (numTicks - 1))
      const x = timeXOffset + timeWaveWidth - (i / (numTicks - 1)) * timeWaveWidth

      let label
      let color
      if (timeValue === 0) {
        const now = new Date()
        const hours = String(now.getHours()).padStart(2, '0')
        const minutes = String(now.getMinutes()).padStart(2, '0')
        const seconds = String(now.getSeconds()).padStart(2, '0')
        label = `${hours}:${minutes}:${seconds}`
        color = [76, 175, 80]
      } else {
        label = `${timeValue.toFixed(0)}s`
        color = [144, 202, 249]
      }

      labels.push({
        position: [x, timeAxisY + 17],
        text: label,
        color: color,
        size: 10,
        anchor: 'middle',
        alignmentBaseline: 'center'
      })
    }

    layers.push(new TextLayer({
      id: 'labels',
      data: labels,
      getPosition: d => d.position,
      getText: d => d.text,
      getColor: d => d.color,
      getSize: d => d.size,
      getTextAnchor: d => d.anchor,
      getAlignmentBaseline: d => d.alignmentBaseline,
      fontFamily: 'monospace',
      fontWeight: 'normal'
    }))

    return layers
  }, [stations, stationMap, waveDataMap, currentTime, hoveredStation, minLat, maxLat, simpleLayout, panelWidth, panelHeight])

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
    const timeAxisY = panelHeight - 25
    const axisWaveWidth = panelWidth * 0.75
    const axisXOffset = panelWidth * 0.15

    const lines = [{
      path: [[axisXOffset, timeAxisY], [axisXOffset + axisWaveWidth, timeAxisY]],
      color: [255, 255, 255, 76]
    }]

    const numTicks = 7
    for (let i = 0; i < numTicks; i++) {
      const x = axisXOffset + axisWaveWidth - (i / (numTicks - 1)) * axisWaveWidth
      lines.push({
        path: [[x, timeAxisY], [x, timeAxisY + 5]],
        color: [255, 255, 255, 76]
      })
    }

    return new PathLayer({
      id: 'time-axis',
      data: lines,
      getPath: d => d.path,
      getColor: d => d.color,
      widthMinPixels: 1
    })
  }, [panelWidth, panelHeight])

  const allLayers = [...gridLayers, timeAxisLayer, ...waveformLayers, ...labelLayers]

  const views = new OrthographicView({
    id: 'ortho',
    controller: false,
    flipY: false // 不翻转Y轴，使用top-left原点
  })

  // 使用左上角为原点的坐标系统
  const initialViewState = {
    target: [panelWidth / 2, panelHeight / 2, 0],
    zoom: 0
  }

  return (
    <div className="geographic-wave-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{stations.length} 站</span>
      </div>
      <div className="deckgl-container" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <DeckGL
          views={views}
          initialViewState={initialViewState}
          viewState={{
            target: [panelWidth / 2, panelHeight / 2, 0],
            zoom: 0
          }}
          layers={allLayers}
          width={panelWidth}
          height={panelHeight}
          style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
          controller={false}
          parameters={{
            clearColor: [0.04, 0.055, 0.153, 1]
          }}
          getTooltip={({ object }) => object && object.station && {
            text: object.station,
            style: { background: 'rgba(0, 0, 0, 0.8)', color: '#fff' }
          }}
        />
      </div>
    </div>
  )
}

GeographicWavePanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  simpleLayout: PropTypes.bool,
  currentTime: PropTypes.number.isRequired,
  panelWidth: PropTypes.number.isRequired,
  panelHeight: PropTypes.number.isRequired
}

function RealtimeWaveformDeck({ targetStations, wavePackets, selectedStations = [] }) {
  const [stationMap, setStationMap] = useState({})
  const [waveDataMap, setWaveDataMap] = useState({})
  const [westLatRange, setWestLatRange] = useState({ min: EAST_LAT_MIN, max: LAT_MAX })
  const [useNearestTSMIP, setUseNearestTSMIP] = useState(false) // 是否啟用自動尋找最近 TSMIP 測站
  const [nearestStationCache, setNearestStationCache] = useState({}) // 緩存最近測站的映射
  const leftColumnRef = useRef(null)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [dimensions, setDimensions] = useState({
    westWidth: 800,
    westHeight: 600,
    islandsWidth: 800,
    islandsHeight: 200,
    eastWidth: 800,
    eastHeight: 800,
    selectedWidth: 800,
    selectedHeight: 300
  })

  // 建立測站快速查找 Map
  useEffect(() => {
    const map = {}

    targetStations.forEach(station => {
      map[station.station] = station
    })

    fetch('http://localhost:5001/api/all-stations')
      .then(response => response.json())
      .then(stations => {
        stations.forEach(station => {
          if (!map[station.station]) {
            map[station.station] = {
              ...station,
              isSecondary: true
            }
          }
        })
        setStationMap({ ...map })
        console.log('📍 [Deck] stationMap updated:', Object.keys(map).length, 'stations')
      })
      .catch(err => {
        console.error('❌ Failed to load all stations:', err)
        setStationMap(map)
        console.log('📍 [Deck] stationMap updated:', Object.keys(map).length, 'stations (primary only)')
      })
  }, [targetStations])

  // 當啟用自動替換時，為每個 CWASN 測站查找最近的 TSMIP 測站
  useEffect(() => {
    if (!useNearestTSMIP) {
      setNearestStationCache({})
      return
    }

    const fetchNearestStations = async () => {
      const cache = {}

      for (const station of targetStations) {
        const stationCode = station.station

        // 如果已經是 TSMIP 格式，跳過
        if (isTSMIPStation(stationCode)) {
          continue
        }

        // 如果沒有經緯度，跳過
        if (!station.latitude || !station.longitude) {
          continue
        }

        try {
          const response = await fetch(
            `http://localhost:5001/api/find-nearest-station?lat=${station.latitude}&lon=${station.longitude}&exclude_pattern=CWASN&max_count=1`
          )

          if (response.ok) {
            const nearestStations = await response.json()
            if (nearestStations && nearestStations.length > 0) {
              const nearest = nearestStations[0]
              cache[stationCode] = {
                originalStation: stationCode,
                replacementStation: nearest.station,
                distance: nearest.distance_km,
                coordinates: {
                  lat: nearest.latitude,
                  lon: nearest.longitude
                }
              }
              console.log(`🔄 [替換] ${stationCode} → ${nearest.station} (距離: ${nearest.distance_km} km)`)
            }
          }
        } catch (error) {
          console.error(`❌ 無法為 ${stationCode} 查找最近測站:`, error)
        }
      }

      setNearestStationCache(cache)
      console.log('✅ 最近測站映射已建立:', Object.keys(cache).length, '個替換')
    }

    fetchNearestStations()
  }, [useNearestTSMIP, targetStations])

  // 初始化所有測站的數據結構
  useEffect(() => {
    if (targetStations.length === 0) return

    setWaveDataMap(prev => {
      const updated = { ...prev }
      targetStations.forEach(station => {
        if (!updated[station.station]) {
          updated[station.station] = {
            dataPoints: [],
            lastPga: 0
          }
        }
      })
      return updated
    })
  }, [targetStations])

  // 更新當前時間
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now())
    }, 100)
    return () => clearInterval(interval)
  }, [])

  // 處理新的波形數據
  useEffect(() => {
    if (wavePackets.length === 0) return

    const latestPacket = wavePackets[0]
    const packetTimestamp = latestPacket.timestamp || Date.now()

    setWaveDataMap(prev => {
      const updated = { ...prev }

      if (latestPacket.data) {
        Object.keys(latestPacket.data).forEach(seedStation => {
          const stationCode = extractStationCode(seedStation)

          if (!updated[stationCode]) {
            updated[stationCode] = {
              dataPoints: [],
              lastPga: 0
            }
          }

          const stationData = updated[stationCode]
          const waveform = latestPacket.data[seedStation]?.waveform || []
          const pga = latestPacket.data[seedStation]?.pga || 0

          stationData.dataPoints.push({
            timestamp: packetTimestamp,
            values: waveform
          })

          const cutoffTime = Date.now() - TIME_WINDOW * 1000
          stationData.dataPoints = stationData.dataPoints.filter(
            point => point.timestamp >= cutoffTime
          )

          stationData.lastPga = pga

          // 動態縮放
          const recentCutoff = Date.now() - 10 * 1000
          const recentPoints = stationData.dataPoints.filter(
            point => point.timestamp >= recentCutoff
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
            stationData.displayScale = Math.max(rms * 8, maxAbs * 0.6, 0.05)
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
      if (leftColumnRef.current) {
        const rect = leftColumnRef.current.getBoundingClientRect()
        const westHeight = rect.height - ISLANDS_PANEL_HEIGHT - PANEL_GAP

        setDimensions({
          westWidth: rect.width,
          westHeight: westHeight,
          islandsWidth: rect.width,
          islandsHeight: ISLANDS_PANEL_HEIGHT,
          eastWidth: rect.width,
          eastHeight: rect.height,
          selectedWidth: rect.width,
          selectedHeight: 300
        })
      }
    }

    updateSize()
    window.addEventListener('resize', updateSize)

    const resizeObserver = new ResizeObserver(updateSize)
    if (leftColumnRef.current) {
      resizeObserver.observe(leftColumnRef.current)
    }

    return () => {
      window.removeEventListener('resize', updateSize)
      resizeObserver.disconnect()
    }
  }, [])

  // 計算西部面板的緯度範圍
  useEffect(() => {
    const calculateWestLatRange = () => {
      if (!leftColumnRef.current) return

      const leftColumnHeight = leftColumnRef.current.clientHeight
      const westPanelHeight = leftColumnHeight - ISLANDS_PANEL_HEIGHT - PANEL_GAP
      const eastPanelHeight = leftColumnHeight
      const eastLatRange = LAT_MAX - EAST_LAT_MIN
      const westLatRange = eastLatRange * (westPanelHeight / eastPanelHeight)
      const westLatMin = LAT_MAX - westLatRange

      setWestLatRange({ min: westLatMin, max: LAT_MAX })
    }

    calculateWestLatRange()
    window.addEventListener('resize', calculateWestLatRange)

    const resizeObserver = new ResizeObserver(calculateWestLatRange)
    if (leftColumnRef.current) {
      resizeObserver.observe(leftColumnRef.current)
    }

    return () => {
      window.removeEventListener('resize', calculateWestLatRange)
      resizeObserver.disconnect()
    }
  }, [])

  // 根據模式動態計算顯示的測站列表
  const displayStations = useMemo(() => {
    if (!useNearestTSMIP || Object.keys(nearestStationCache).length === 0) {
      return STATION_GROUPS
    }

    // 替換模式：將 CWASN 測站替換為最近的 TSMIP 測站
    const replaceStations = (stations) => {
      return stations.map(stationCode => {
        const replacement = nearestStationCache[stationCode]
        return replacement ? replacement.replacementStation : stationCode
      })
    }

    return {
      east: {
        title: `東部測站 ${useNearestTSMIP ? '(智能替換)' : ''}`,
        stations: replaceStations(STATION_GROUPS.east.stations)
      },
      west: {
        title: `西部測站 ${useNearestTSMIP ? '(智能替換)' : ''}`,
        stations: replaceStations(STATION_GROUPS.west.stations)
      },
      islands: {
        title: `離島測站 ${useNearestTSMIP ? '(智能替換)' : ''}`,
        stations: replaceStations(STATION_GROUPS.islands.stations)
      }
    }
  }, [useNearestTSMIP, nearestStationCache])

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
            ? `自動將無資料的 CWASN 測站替換為最近的 TSMIP 測站 (已替換 ${Object.keys(nearestStationCache).length} 個測站)`
            : '使用原始 CWASN 測站配置'}
        </span>
      </div>
      <div className="waveform-grid geographic-grid">
        <div ref={leftColumnRef} className="left-column">
          <GeographicWavePanel
            title={displayStations.west.title}
            stations={displayStations.west.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={westLatRange.min}
            latMax={westLatRange.max}
            currentTime={currentTime}
            panelWidth={dimensions.westWidth}
            panelHeight={dimensions.westHeight}
          />
          <GeographicWavePanel
            title={displayStations.islands.title}
            stations={displayStations.islands.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            simpleLayout={true}
            currentTime={currentTime}
            panelWidth={dimensions.islandsWidth}
            panelHeight={dimensions.islandsHeight}
          />
        </div>

        <div className="right-column">
          <GeographicWavePanel
            title={displayStations.east.title}
            stations={displayStations.east.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={EAST_LAT_MIN}
            latMax={EAST_LAT_MAX}
            currentTime={currentTime}
            panelWidth={dimensions.eastWidth}
            panelHeight={dimensions.eastHeight}
          />
          {selectedStations.length > 0 && (
            <GeographicWavePanel
              title={`測試群組 (${selectedStations.length})`}
              stations={selectedStations}
              stationMap={stationMap}
              waveDataMap={waveDataMap}
              simpleLayout={true}
              currentTime={currentTime}
              panelWidth={dimensions.selectedWidth}
              panelHeight={dimensions.selectedHeight}
            />
          )}
        </div>
      </div>
    </div>
  )
}

RealtimeWaveformDeck.propTypes = {
  targetStations: PropTypes.array.isRequired,
  wavePackets: PropTypes.array.isRequired,
  selectedStations: PropTypes.array
}

export default RealtimeWaveformDeck

