import React from 'react'
import PropTypes from 'prop-types'
import TaiwanMap from './TaiwanMapDeck'

/**
 * 取得震度對應的顏色
 */
function getIntensityColor(intensity) {
  switch (intensity) {
    case "0": return [255, 255, 255]     // #ffffff 白色
    case "1": return [51, 255, 221]      // #33FFDD 青色
    case "2": return [52, 255, 50]       // #34ff32 綠色
    case "3": return [254, 253, 50]      // #fefd32 黃色
    case "4": return [254, 133, 50]      // #fe8532 橙色
    case "5-": return [253, 82, 51]      // #fd5233 紅色
    case "5+": return [196, 63, 59]      // #c43f3b 深紅
    case "6-": return [157, 70, 70]      // #9d4646 暗紅
    case "6+": return [154, 76, 134]     // #9a4c86 紫紅
    case "7": return [181, 31, 234]      // #b51fea 紫色
    default: return [148, 163, 184]      // #94a3b8 灰色（未知）
  }
}

export default function ReportDetail({ report, onBack, targetStations, onSelectReport, reports }) {
  const [historicalReports, setHistoricalReports] = React.useState([])
  const [selectedHistoricalReport, setSelectedHistoricalReport] = React.useState(null)
  const [historicalReportData, setHistoricalReportData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [filteredReports, setFilteredReports] = React.useState([])
  const [currentIndex, setCurrentIndex] = React.useState(-1)
  const [historicalPredictions, setHistoricalPredictions] = React.useState([])
  const [selectedPredictionIndex, setSelectedPredictionIndex] = React.useState(-1)

  // 當前顯示的報告數據（實時或歷史）
  const currentReport = selectedHistoricalReport ? historicalReportData : report
  const currentData = selectedHistoricalReport && selectedPredictionIndex >= 0 ? historicalPredictions[selectedPredictionIndex] : currentReport?.data || {}

  // 載入歷史報告列表
  React.useEffect(() => {
    fetch('http://localhost:5001/api/reports')
      .then(res => res.json())
      .then(reports => {
        setHistoricalReports(reports)
      })
      .catch(err => console.error('載入歷史報告失敗:', err))
  }, [])

  // 當 report prop 改變時，重置歷史報告相關狀態
  React.useEffect(() => {
    setSelectedHistoricalReport(null)
    setHistoricalReportData(null)
    setCurrentIndex(-1)
    setHistoricalPredictions([])
    setSelectedPredictionIndex(-1)
  }, [report])

  // 篩選與當前事件相關的歷史報告（同一天）
  React.useEffect(() => {
    if (historicalReports.length > 0 && currentReport?.timestamp) {
      const currentDate = currentReport.timestamp.split('_')[0]; // 提取日期部分，如 '2025-10-15'
      const filtered = historicalReports.filter(r => r.datetime.startsWith(currentDate));
      setFilteredReports(filtered);
      // 如果只有一個檔案且未選擇歷史報告，自動載入
      if (filtered.length === 1 && !selectedHistoricalReport) {
        loadHistoricalReport(filtered[0].filename);
      }
      // 更新當前索引
      if (selectedHistoricalReport) {
        const index = filtered.findIndex(r => r.filename === selectedHistoricalReport);
        setCurrentIndex(index);
      } else {
        setCurrentIndex(-1);
      }
    }
  }, [historicalReports, currentReport?.timestamp, selectedHistoricalReport]);

  // 載入歷史報告內容
  const loadHistoricalReport = async (filename) => {
    setLoading(true)
    try {
      const response = await fetch(`http://localhost:5001/get_file_content?file=${filename}`)
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
    setCurrentIndex(-1)
    setHistoricalPredictions([])
    setSelectedPredictionIndex(-1)
  }

  // 切換到上一個歷史報告
  const goToPrevious = () => {
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      setCurrentIndex(newIndex);
      loadHistoricalReport(filteredReports[newIndex].filename);
    }
  };

  // 切換到下一個歷史報告
  const goToNext = () => {
    if (currentIndex < filteredReports.length - 1 && currentIndex !== -1) {
      const newIndex = currentIndex + 1;
      setCurrentIndex(newIndex);
      loadHistoricalReport(filteredReports[newIndex].filename);
    }
  };

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
          <h2>📊 預測報告詳細資訊</h2>
          <span className="detail-timestamp">{currentReport.timestamp}</span>
          {selectedHistoricalReport && (
            <span className="historical-indicator">📚 歷史報告</span>
          )}
        </div>
        <div className="detail-header-right">
          {/* 歷史報告選擇器 */}
          {report.isHistorical && filteredReports.length > 0 && (
            <div className="historical-selector">
              <label htmlFor="historical-reports">歷史報告：</label>
              {selectedHistoricalReport ? (
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
              ) : (
                <select
                  id="historical-reports"
                  value={selectedHistoricalReport || ''}
                  onChange={(e) => {
                    const filename = e.target.value;
                    if (filename) {
                      const index = filteredReports.findIndex(r => r.filename === filename);
                      setCurrentIndex(index);
                      loadHistoricalReport(filename);
                    } else {
                      clearHistoricalSelection();
                    }
                  }}
                  disabled={loading}
                >
                <option value="">選擇歷史報告...</option>
                {filteredReports.map(report => (
                  <option key={report.filename} value={report.filename}>
                    {report.datetime} - {report.filename}
                  </option>
                ))}
              </select>
              )}
              <div className="navigation-buttons">
                <button onClick={goToPrevious} disabled={currentIndex <= 0 || filteredReports.length === 0}>↑</button>
                <button onClick={goToNext} disabled={currentIndex >= filteredReports.length - 1 || currentIndex === -1}>↓</button>
              </div>
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

      {/* 震度地圖 */}
      <div className="detail-section">
        <h3>🗺️ 測站預測震度分布</h3>
        <div style={{ height: '400px', width: '100%', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
          <TaiwanMap
            stations={targetStations}
            stationReplacements={{}}
            stationIntensities={reportStationIntensities}
          />
        </div>
      </div>

      {data.alarm && data.alarm.length > 0 && (
        <div className="detail-section">
          <h3>警報測站列表</h3>
          <div className="station-grid">
            {data.alarm.map((station, idx) => (
              <div key={idx} className="station-badge alert">
                {station}: {data[station] || 'N/A'}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="detail-section">
        <h3>所有測站震度</h3>
        <div className="station-grid">
          {Object.keys(data).filter(key => !['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key)).map((station, idx) => (
            <div key={idx} className="station-badge">
              {station}: {data[station] || 'N/A'}
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3>原始資料</h3>
        <pre className="detail-json">
          {JSON.stringify(data, null, 2)}
        </pre>
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
