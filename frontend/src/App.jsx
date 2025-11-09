import { useState, useEffect } from 'react'
import io from 'socket.io-client'
import './App.css'
import ReportDetail from './components/ReportDetail'
import TaiwanMap from './components/TaiwanMapDeck'
import RealtimeWaveform from './components/RealtimeWaveformDeck'

/**
 * 從 SEED 格式提取測站代碼
 * 格式：SM.{station}.01.HLZ -> {station}
 */
function extractStationCode(seedName) {
  if (!seedName) return seedName
  const parts = seedName.split('.')
  if (parts.length >= 2) {
    return parts[1]
  }
  return seedName
}

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [wavePackets, setWavePackets] = useState([])
  const [latestWaveTime, setLatestWaveTime] = useState(null) // 最新波形時間
  const [targetStations, setTargetStations] = useState([]) // eew_target 測站列表
  const [socket, setSocket] = useState(null) // Socket 實例，供子組件使用
  const [stationReplacements, setStationReplacements] = useState({}) // 測站替換映射
  const [stationIntensities, setStationIntensities] = useState({}) // 測站震度數據
  const [reports, setReports] = useState([]) // 預測報告數據

  // 載入歷史報告
  const loadHistoricalReports = async (limit = 20) => {
    try {
      // 獲取歷史報告列表
      const reportsResponse = await fetch('http://localhost:5001/api/reports')
      const reportFiles = await reportsResponse.json()

      // 載入最近的幾個歷史報告
      const historicalReports = []
      for (let i = 0; i < Math.min(limit, reportFiles.length); i++) {
        const file = reportFiles[i]
        try {
          const contentResponse = await fetch(`http://localhost:5001/get_file_content?file=${file.filename}`)
          const text = await contentResponse.text()
          const jsonData = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))

          // 使用最新的報告數據（通常是最後一行）
          const latestData = jsonData[jsonData.length - 1]

          historicalReports.push({
            id: `historical_${file.filename}_${Date.now()}`,
            timestamp: file.datetime,
            data: latestData,
            isHistorical: true,
            filename: file.filename
          })
        } catch (err) {
          console.error(`載入歷史報告 ${file.filename} 失敗:`, err)
        }
      }

      setReports(prev => [...historicalReports, ...prev])
      console.log(`📚 Loaded ${historicalReports.length} historical reports`)
    } catch (err) {
      console.error('載入歷史報告失敗:', err)
    }
  }

  // 右側詳細頁面狀態
  const [selectedType, setSelectedType] = useState(null) // 'event' | 'wave' | 'dataset'
  const [selectedItem, setSelectedItem] = useState(null)

  useEffect(() => {
    // 載入 eew_target 測站資料
    fetch('http://localhost:5001/api/stations')
      .then(res => res.json())
      .then(stations => {
        const stationsWithStatus = stations.map(s => ({
          ...s,
          status: 'unknown', // unknown, online, warning, offline
          lastSeen: null,
          pga: null
        }))
        setTargetStations(stationsWithStatus)
        console.log('📍 Loaded', stationsWithStatus.length, 'target stations')
      })
      .catch(err => console.error('載入測站資料失敗:', err))

    // 連接到 Mock Server 的 SocketIO
    const socket = io('http://localhost:5001', {
      transports: ['websocket', 'polling']
    })

    // 保存 socket 實例
    setSocket(socket)

    // 連線事件
    const handleConnect = () => {
      console.log('✅ Connected to Mock Server')
      setIsConnected(true)
    }

    const handleDisconnect = () => {
      console.log('❌ Disconnected from Mock Server')
      setIsConnected(false)
    }

    const handleConnectInit = () => {
      console.log('🔌 Connection initialized')
      // 載入歷史報告
      loadHistoricalReports(20)
    }

    // 接收波形資料
    const handleWavePacket = (data) => {
      console.log('🌊 Wave packet received:', data.waveid)
      const timestamp = new Date().toLocaleString('zh-TW')
      setLatestWaveTime(timestamp)
      setWavePackets(prev => [data, ...prev].slice(0, 10)) // 保留最新 10 筆（供詳細查看）
    }

    // 接收地震事件
    const handleEventData = (data) => {
      console.log('📍 Event data received:', Object.keys(data).length, 'stations')
      const timestamp = new Date().toLocaleString('zh-TW')
      // 從 SEED 格式提取測站代碼
      const stationCodes = Object.keys(data).map(seedName => extractStationCode(seedName))
      setEvents(prev => [{
        id: Date.now(),
        timestamp,
        stations: stationCodes,
        data
      }, ...prev].slice(0, 20)) // 保留最新 20 筆
    }

    // 接收預測報告
    const handleReportData = (data) => {
      console.log('📊 Report data received:', data)
      const timestamp = new Date().toLocaleString('zh-TW')
      setReports(prev => [{
        id: Date.now(),
        timestamp,
        data,
        isRealtime: true
      }, ...prev].slice(0, 20)) // 保留最新 20 筆（歷史+即時）
    }

    // 註冊事件監聽器
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_init', handleConnectInit)
    socket.on('wave_packet', handleWavePacket)
    socket.on('report_data', handleReportData)

    // 清理函式
    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_init', handleConnectInit)
      socket.off('wave_packet', handleWavePacket)
      socket.off('report_data', handleReportData)
      socket.disconnect()
    }
  }, []) // 空依賴陣列，確保只執行一次

  // 回到波形頁面
  const handleBackToWaveform = () => {
    setSelectedType(null)
    setSelectedItem(null)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1
            className="app-title clickable"
            onClick={handleBackToWaveform}
            title="點擊回到首頁"
          >
            🌏 TTSAM 地震預警即時監控
          </h1>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 已連接' : '🔴 未連接'}
          </div>
        </div>
        <div className="header-right">
          {!latestWaveTime ? (
            <div className="wave-status-compact waiting">
              <span className="wave-icon">⏳</span>
              <span className="wave-text">等待波形</span>
            </div>
          ) : (
            <div
              className="wave-status-compact active clickable"
              onClick={handleBackToWaveform}
              title="點擊回到波形顯示"
            >
              <span className="wave-icon">🌊</span>
              <span className="wave-text">{latestWaveTime}</span>
            </div>
          )}
        </div>
      </header>

      <div className="dashboard">
        {/* 左側面板：即時更新列表 */}
        <div className="left-panel">
          {/* 預測報告列表 */}
          <section className="section events-section">
            <h2>📊 預測報告 ({reports.length})</h2>
            <div className="event-list">
              {reports.length === 0 ? (
                <p className="empty-message">等待預測報告資料...</p>
              ) : (
                reports.map(report => (
                  <div
                    key={report.id}
                    className={`event-card ${selectedType === 'report' && selectedItem?.id === report.id ? 'selected' : ''} ${report.isHistorical ? 'historical' :  ''}`}
                    onClick={() => {
                      setSelectedType('report')
                      setSelectedItem(report)
                    }}
                  >
                    <div className="event-header">
                      <span className="event-time">
                        {report.timestamp}
                        {report.isHistorical && <span className="report-type-indicator">📚</span>}
                      </span>
                    </div>
                    <div className="event-stations-list">
                      {report.data.alarm && report.data.alarm.slice(0, 5).map((station, idx) => (
                        <span key={idx} className="station-tag">{station}</span>
                      ))}
                      {report.data.alarm && report.data.alarm.length > 5 && (
                        <span className="station-tag more">+{report.data.alarm.length - 5}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 台灣地圖 - 顯示主要測站 + 次要測站（TSMIP）*/}
          <section className="section map-section">
            <h2>🗺️ 測站分布</h2>
            <TaiwanMap
              stations={targetStations}
              stationReplacements={stationReplacements}
              stationIntensities={stationIntensities}
            />
          </section>
        </div>

        {/* 右側面板：詳細內容 */}
        <div className="right-panel">
          {!selectedType ? (
            <RealtimeWaveform
              wavePackets={wavePackets}
              socket={socket}
              onReplacementUpdate={setStationReplacements}
              onStationIntensityUpdate={setStationIntensities}
            />
          ) : (
            <>
              {selectedType === 'wave' && (
                <WaveDetail
                  wave={selectedItem}
                  onBack={handleBackToWaveform}
                />
              )}
              {selectedType === 'report' && (
                <ReportDetail
                  report={selectedItem}
                  onBack={handleBackToWaveform}
                  targetStations={targetStations}
                  onSelectReport={(report) => setSelectedItem(report)}
                  reports={reports}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
