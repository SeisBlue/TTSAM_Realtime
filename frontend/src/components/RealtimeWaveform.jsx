import { useState, useEffect, useRef } from 'react'
import PropTypes from 'prop-types'
import './RealtimeWaveform.css'

// 測站分組：東部、西部、離島三組
const STATION_GROUPS = {
  east: {
    title: '東部測站',
    stations: [
      // 基隆（特殊歸類到東部）
      'NOU',
      // 雙溪
      'TIPB',
      // 宜蘭
      'ILA', 'TWC', 'ENT',
      // 花蓮
      'HWA', 'EGFH', 'EYUL',
      // 台東
      'TTN', 'ECS', 'TAWH',
      // 恆春（特殊歸類到東部）
      'HEN'
    ]
  },
  west: {
    title: '西部測站',
    stations: [
      // 台北、新北（除基隆外）
      'TAP', 'A024', 'NTS',
      // 桃園
      'NTY', 'NCU', 'B011',
      // 新竹
      'HSN1', 'HSN', 'NJD',
      // 苗栗
      'B131', 'TWQ1', 'B045',
      // 台中
      'TCU', 'WDJ', 'WHP',
      // 南投
      'WNT1', 'WPL', 'WHY',
      // 彰化
      'WCHH', 'WYL',
      // 雲林
      'WDL', 'WSL',
      // 嘉義
      'CHY1', 'C095', 'WCKO',
      // 台南
      'TAI', 'C015', 'CHN1',
      // 高雄
      'KAU', 'SCS',
      // 屏東（除恆春外）
      'SPT', 'SSD'
    ]
  },
  islands: {
    title: '離島測站',
    stations: [
      // 澎湖
      'PNG',
      // 金門
      'KNM',
      // 馬祖
      'MSU'
    ]
  }
}

// 緯度範圍設定
const LAT_MIN = 22.0  // 全台最南（恆春 HEN）
const LAT_MAX = 25.4  // 顯示範圍最北（留餘裕避免波形被切）

// 西部測站緯度範圍（最南到屏東 SPT 22.677）
const WEST_LAT_MIN = 22.5
const WEST_LAT_MAX = 25.4

// 東部測站緯度範圍（最南到恆春 HEN 22.006）
const EAST_LAT_MIN = 22.0
const EAST_LAT_MAX = 25.4

function GeographicWavePanel({ title, stations, stationMap, waveDataMap, latMin, latMax, simpleLayout }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  // 使用傳入的緯度範圍，或使用預設值
  const minLat = latMin ?? LAT_MIN
  const maxLat = latMax ?? LAT_MAX

  // 響應式尺寸
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setDimensions({ width: rect.width, height: rect.height })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  // 繪製波型
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const { width, height } = dimensions

    // 清空畫布
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#0a0e27'
    ctx.fillRect(0, 0, width, height)

    // 繪製緯度參考線（簡單佈局時不繪製）
    const drawLatitudeGrid = () => {
      if (simpleLayout) return // 離島面板不顯示緯度線

      ctx.strokeStyle = 'rgba(100, 181, 246, 0.15)'
      ctx.lineWidth = 1
      ctx.font = '11px monospace'
      ctx.fillStyle = '#64b5f6'

      for (let lat = Math.ceil(minLat); lat <= maxLat; lat += 0.5) {
        const y = ((maxLat - lat) / (maxLat - minLat)) * height

        // 整數緯度用實線，半度用虛線
        if (lat % 1 === 0) {
          ctx.strokeStyle = 'rgba(100, 181, 246, 0.3)'
          ctx.setLineDash([])
        } else {
          ctx.strokeStyle = 'rgba(100, 181, 246, 0.15)'
          ctx.setLineDash([5, 5])
        }

        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()

        // 整數緯度標籤
        if (lat % 1 === 0) {
          ctx.fillStyle = '#64b5f6'
          ctx.fillText(`${lat}°N`, 8, y - 5)
        }
      }
      ctx.setLineDash([]) // 重置虛線
    }

    drawLatitudeGrid()

    // 繪製各測站波型
    const waveWidth = width * 0.75 // 波型寬度占 75%
    const waveHeight = 30 // 波型最大振幅高度
    const xOffset = width * 0.15 // 左側留白 15%

    stations.forEach((stationCode, index) => {
      const station = stationMap[stationCode]
      if (!station) return

      // 計算 Y 位置
      let centerY
      if (simpleLayout) {
        // 簡單佈局：均勻分布測站
        const spacing = height / (stations.length + 1)
        centerY = spacing * (index + 1)
      } else {
        // 緯度佈局：基於實際緯度
        if (!station.latitude) return
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * height
      }

      const waveData = waveDataMap[stationCode]

      // 繪製測站基線（灰色虛線）
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
      ctx.lineWidth = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(xOffset, centerY)
      ctx.lineTo(xOffset + waveWidth, centerY)
      ctx.stroke()
      ctx.setLineDash([])

      // 繪製測站標籤（左側）
      ctx.fillStyle = waveData ? '#e0e0e0' : '#666'
      ctx.font = '10px monospace'
      ctx.textAlign = 'right'
      ctx.fillText(stationCode, xOffset - 8, centerY + 3)

      // 繪製測站資訊（右側）
      ctx.textAlign = 'left'
      ctx.font = '9px sans-serif'
      if (station.station_zh) {
        ctx.fillText(station.station_zh, xOffset + waveWidth + 5, centerY - 2)
      }
      if (waveData?.pga) {
        ctx.fillStyle = '#4caf50'
        ctx.fillText(`${waveData.pga.toFixed(1)}`, xOffset + waveWidth + 5, centerY + 8)
      }

      // 繪製波型（如果有資料）
      if (!waveData || !waveData.waveform || waveData.waveform.length === 0) return

      const waveform = waveData.waveform

      // 正規化波形
      let min = Infinity, max = -Infinity
      waveform.forEach(v => {
        if (v < min) min = v
        if (v > max) max = v
      })
      const range = (max - min) || 1

      // 繪製波形線
      ctx.beginPath()

      // 根據狀態選擇顏色
      const now = Date.now()
      const age = now - (waveData.timestamp || 0)
      if (age < 2000) {
        ctx.strokeStyle = '#4caf50' // 活躍：綠色
      } else if (age < 5000) {
        ctx.strokeStyle = '#2196f3' // 最近：藍色
      } else {
        ctx.strokeStyle = '#ff9800' // 過時：橘色
      }

      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.9

      waveform.forEach((v, i) => {
        const x = xOffset + (i / (waveform.length - 1)) * waveWidth
        const normalizedValue = ((v - min) / range - 0.5) * 2 // -1 到 1
        const y = centerY - normalizedValue * (waveHeight / 2)

        if (i === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
      })
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.textAlign = 'left' // 重置對齊
    })
  }, [stations, stationMap, waveDataMap, dimensions])

  return (
    <div ref={containerRef} className="geographic-wave-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{stations.length} 站</span>
      </div>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ width: '100%', height: '100%' }}
      />
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
  simpleLayout: PropTypes.bool
}

function RealtimeWaveform({ targetStations, wavePackets }) {
  const [stationMap, setStationMap] = useState({})
  const [waveDataMap, setWaveDataMap] = useState({})

  // 建立測站快速查找 Map
  useEffect(() => {
    const map = {}
    targetStations.forEach(station => {
      map[station.station] = station
    })
    setStationMap(map)
  }, [targetStations])

  // 更新波形資料 Map
  useEffect(() => {
    if (wavePackets.length === 0) return

    const latestPacket = wavePackets[0]
    const newWaveDataMap = {}

    // 從最新的 wave_packet 中提取各測站資料
    if (latestPacket.data) {
      Object.keys(latestPacket.data).forEach(station => {
        newWaveDataMap[station] = {
          timestamp: Date.now(),
          pga: latestPacket.data[station]?.pga || 0,
          waveform: latestPacket.data[station]?.waveform || [],
          status: 'active'
        }
      })
    }

    setWaveDataMap(prev => ({...prev, ...newWaveDataMap}))
  }, [wavePackets])

  return (
    <div className="realtime-waveform geographic">
      <div className="waveform-grid geographic-grid">
        {/* 左側 column：西部 + 離島 */}
        <div className="left-column">
          <GeographicWavePanel
            title={STATION_GROUPS.west.title}
            stations={STATION_GROUPS.west.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={WEST_LAT_MIN}
            latMax={WEST_LAT_MAX}
          />
          <GeographicWavePanel
            title={STATION_GROUPS.islands.title}
            stations={STATION_GROUPS.islands.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            simpleLayout={true}
          />
        </div>

        {/* 右側 column：東部 */}
        <GeographicWavePanel
          title={STATION_GROUPS.east.title}
          stations={STATION_GROUPS.east.stations}
          stationMap={stationMap}
          waveDataMap={waveDataMap}
          latMin={EAST_LAT_MIN}
          latMax={EAST_LAT_MAX}
        />
      </div>
    </div>
  )
}

RealtimeWaveform.propTypes = {
  targetStations: PropTypes.array.isRequired,
  wavePackets: PropTypes.array.isRequired
}

export default RealtimeWaveform

