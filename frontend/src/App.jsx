import { useState, useEffect } from 'react'
import io from 'socket.io-client'
import './App.css'
import EventDetail from './components/EventDetail'
import WaveDetail from './components/WaveDetail'
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
  const [events, setEvents] = useState([])
  const [wavePackets, setWavePackets] = useState([])
  const [latestWaveTime, setLatestWaveTime] = useState(null) // 最新波形時間
  const [targetStations, setTargetStations] = useState([]) // eew_target 測站列表
  const [selectedStations, setSelectedStations] = useState([]) // 用戶選中的測站（用於測試群組）
  const [socket, setSocket] = useState(null) // Socket 實例，供子組件使用
  const [stationReplacements, setStationReplacements] = useState({}) // 測站替換映射

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

    // 註冊事件監聽器
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_init', handleConnectInit)
    socket.on('wave_packet', handleWavePacket)
    socket.on('event_data', handleEventData)

    // 清理函式
    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_init', handleConnectInit)
      socket.off('wave_packet', handleWavePacket)
      socket.off('event_data', handleEventData)
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
          {/* 地震事件列表 */}
          <section className="section events-section">
            <h2>📍 地震事件 ({events.length})</h2>
            <div className="event-list">
              {events.length === 0 ? (
                <p className="empty-message">等待地震事件資料...</p>
              ) : (
                events.map(event => (
                  <div
                    key={event.id}
                    className={`event-card ${selectedType === 'event' && selectedItem?.id === event.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedType('event')
                      setSelectedItem(event)
                    }}
                  >
                    <div className="event-header">
                      <span className="event-time">{event.timestamp}</span>
                      <span className="event-stations">{event.stations.length} 個測站</span>
                    </div>
                    <div className="event-stations-list">
                      {event.stations.slice(0, 5).map((station, idx) => (
                        <span key={idx} className="station-tag">{station}</span>
                      ))}
                      {event.stations.length > 5 && (
                        <span className="station-tag more">+{event.stations.length - 5}</span>
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
              onStationSelect={setSelectedStations}
              stationReplacements={stationReplacements}
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
            />
          ) : (
            <>
              {selectedType === 'event' && (
                <EventDetail
                  event={selectedItem}
                  onBack={handleBackToWaveform}
                />
              )}
              {selectedType === 'wave' && (
                <WaveDetail
                  wave={selectedItem}
                  onBack={handleBackToWaveform}
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
