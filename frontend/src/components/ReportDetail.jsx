import React from 'react'
import PropTypes from 'prop-types'
import TaiwanMap from './TaiwanMapDeck'
import './ReportDetail.css'

/**
 * 取得震度對應的顏色
 * 參考 App.css 的顏色定義
 */
function getIntensityColor(intensity) {
  switch (intensity) {
    // App.css --color-info
    case "0": return [255, 255, 255]     // #ffffff 白色
    case "1": return [78, 205, 196]      // #4ecdc4 青色 (info)
    case "2": return [46, 213, 115]      // #2ed573 綠色 (success)
    case "3": return [255, 167, 38]      // #ffa726 黃色 (warning)
    case "4": return [254, 133, 50]      // #fe8532 橙色 (original)
    case "5-": return [255, 107, 107]     // #ff6b6b 紅色 (danger)
    case "5+": return [196, 63, 59]      // #c43f3b 深紅
    case "6-": return [157, 70, 70]      // #9d4646 暗紅
    case "6+": return [154, 76, 134]     // #9a4c86 紫紅
    case "7": return [181, 31, 234]      // #b51fea 紫色
    default: return [148, 163, 184]      // #94a3b8 灰色（未知）
  }
}

/**
 * 根據震度取得徽章樣式
 */
function getBadgeStyle(intensityStr) {
  const intensityValue = parseInt(intensityStr, 10);
  if (isNaN(intensityValue)) {
    return {}; // 沒有有效震度則返回預設樣式
  }

  const color = getIntensityColor(intensityStr);

  // 震度為 "0" (白色) 時的特殊處理，確保在深色背景下可見
  if (intensityStr === "0") {
    return {
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      color: '#E0E0E0', // --color-text-primary from App.css
      borderColor: 'rgba(255, 255, 255, 0.2)',
    };
  }

  const style = {
    backgroundColor: `rgba(${color.join(',')}, 0.2)`,
    color: `rgb(${color.join(',')})`,
    borderColor: `rgba(${color.join(',')}, 0.4)`,
  };

  return style;
}


export default function ReportDetail({ report, onBack, targetStations, onSelectReport, reports }) {
  const [selectedHistoricalReport, setSelectedHistoricalReport] = React.useState(null)
  const [historicalReportData, setHistoricalReportData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [historicalPredictions, setHistoricalPredictions] = React.useState([])
  const [selectedPredictionIndex, setSelectedPredictionIndex] = React.useState(-1)

  // 當前顯示的報告數據（實時或歷史）
  const currentReport = selectedHistoricalReport ? historicalReportData : report
  const currentData = selectedHistoricalReport && selectedPredictionIndex >= 0 ? historicalPredictions[selectedPredictionIndex] : currentReport?.data || {}

  // 當 report prop 改變時，重置歷史報告相關狀態
  React.useEffect(() => {
    setSelectedHistoricalReport(null)
    setHistoricalReportData(null)
    setHistoricalPredictions([])
    setSelectedPredictionIndex(-1)
    // 如果是歷史報告，自動載入檔案內容
    if (report?.isHistorical && report?.filename) {
      loadHistoricalReport(report.filename)
    }
  }, [report])

  // 載入歷史報告內容
  const loadHistoricalReport = async (filename) => {
    setLoading(true)
    try {
      const response = await fetch(`/get_file_content?file=${filename}`)
      const text = await response.text()
      const jsonData = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))

      setHistoricalPredictions(jsonData)
      setSelectedPredictionIndex(jsonData.length - 1) // 預設選擇最後一個預測

      // 使用最新的報告數據（通常是最後一行）
      const latestData = jsonData[jsonData.length - 1]

      setHistoricalReportData({
        id: filename,
        timestamp: filename,
        data: latestData
      })
      setSelectedHistoricalReport(filename)
    } catch (err) {
      console.error('載入歷史報告內容失敗:', err)
    } finally {
      setLoading(false)
    }
  }

  // 清除歷史報告選擇
  const clearHistoricalSelection = () => {
    setSelectedHistoricalReport(null)
    setHistoricalReportData(null)
    setHistoricalPredictions([])
    setSelectedPredictionIndex(-1)
  }

  // 鍵盤事件處理
  React.useEffect(() => {
    const handleKeyDown = (event) => {
      if (historicalPredictions.length === 0) return;
      let newIndex = selectedPredictionIndex;
      if (event.key === 'ArrowDown') {
        newIndex = Math.min(selectedPredictionIndex + 1, historicalPredictions.length - 1);
        event.preventDefault();
      } else if (event.key === 'ArrowUp') {
        newIndex = Math.max(selectedPredictionIndex - 1, 0);
        event.preventDefault();
      }
      if (newIndex !== selectedPredictionIndex) {
        setSelectedPredictionIndex(newIndex);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [historicalPredictions, selectedPredictionIndex]);

  if (!currentReport) return null

  const data = currentData

  // 從報告數據創建 stationIntensities
  const reportStationIntensities = React.useMemo(() => {
    const intensities = {}
    Object.keys(data).forEach(key => {
      // 跳過非測站數據
      if (['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key)) {
        return
      }

      const intensity = data[key]
      if (intensity && intensity !== 'N/A') {
        intensities[key] = {
          intensity: intensity,
          color: getIntensityColor(intensity),
          pga: 0 // 報告中沒有PGA數據，用0代替
        }
      }
    })
    return intensities
  }, [data])

  return (
    <div className="detail-container">
      <div className="detail-header">
        <div className="detail-header-left">
          <button className="back-button" onClick={onBack}>
            ← 回上頁
          </button>
          <h2>📊 歷史報告詳細資訊</h2>
          <span className="detail-timestamp">{currentReport.timestamp}</span>
          {selectedHistoricalReport && (
            <span className="historical-indicator">📚 歷史報告</span>
          )}
        </div>
        <div className="detail-header-right">
          {/* 歷史報告選擇器 */}
          {report.isHistorical && selectedHistoricalReport && (
            <div className="historical-selector">
              <label htmlFor="historical-reports">預測：</label>
              <select
                id="historical-reports"
                value={selectedPredictionIndex}
                onChange={(e) => {
                  if (e.target.value === 'switch') {
                    clearHistoricalSelection();
                  } else {
                    setSelectedPredictionIndex(parseInt(e.target.value));
                  }
                }}
                disabled={loading}
              >
                <option value="switch">選擇預測...</option>
                {historicalPredictions.map((pred, idx) => (
                  <option key={idx} value={idx}>
                    預測 {idx + 1}: {pred.report_time || 'N/A'}
                  </option>
                ))}
              </select>
              {loading && <span className="loading-indicator">載入中...</span>}
            </div>
          )}
        </div>
      </div>

      {/* 報告摘要 */}
      <div className="detail-section">
        <h3>報告摘要</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <span className="detail-label">觸發測站數</span>
            <span className="detail-value">{data.picks || 0} 個</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">警報測站數</span>
            <span className="detail-value">{data.alarm ? data.alarm.length : 0} 個</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">報告時間</span>
            <span className="detail-value">{data.report_time || 'N/A'}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">波形延遲</span>
            <span className="detail-value">{data.wave_lag ? `${data.wave_lag.toFixed(2)} 秒` : 'N/A'}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">計算時間</span>
            <span className="detail-value">{data.run_time ? `${data.run_time.toFixed(4)} 秒` : 'N/A'}</span>
          </div>
        </div>
      </div>

      <div className="layout-section">
        {/* 震度地圖 */}
        <div className="detail-section map-container">
          <h3>🗺️ 測站預測震度分布</h3>
          <div style={{ height: '400px', width: '100%', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
            <TaiwanMap
              stations={targetStations}
              stationReplacements={{}}
              stationIntensities={reportStationIntensities}
            />
          </div>
        </div>

        {/* 警報測站列表 */}
        {data.alarm && data.alarm.length > 0 && (
          <div className="detail-section stations-container">
            <h3>警報測站列表</h3>
            <div className="station-grid">
              {data.alarm.map((station, idx) => (
                <div key={idx} className="station-badge" style={getBadgeStyle(data[station])}>
                  {station}: {data[station] || 'N/A'}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="layout-section">
        {/* 原始資料 */}
        <div className="detail-section raw-data-container">
          <h3>原始資料</h3>
          <pre className="detail-json">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>

        {/* 所有測站震度 */}
        <div className="detail-section stations-container">
          <h3>所有測站震度</h3>
          <div className="station-grid">
            {Object.keys(data)
              .filter(key => !['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key))
              .map((station, idx) => (
                <div key={idx} className="station-badge" style={getBadgeStyle(data[station])}>
                  {station}: {data[station] || 'N/A'}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

ReportDetail.propTypes = {
  report: PropTypes.object,
  onBack: PropTypes.func.isRequired,
  targetStations: PropTypes.array.isRequired,
  onSelectReport: PropTypes.func,
  reports: PropTypes.array
}
