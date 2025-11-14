import React from 'react'
import PropTypes from 'prop-types'
import TaiwanMap from './TaiwanMapDeck'
import './ReportDetail.css'
import { getIntensityValue, getIntensityColor } from '../utils'

/**
 * 根據震度字串取得對應的 CSS Class 名稱
 * @param {string} intensityStr - 例如 "4", "5-", "5+"
 * @returns {string} - 例如 "intensity-level-4", "intensity-level-5-minus"
 */
function getIntensityClassName(intensityStr) {
  if (!intensityStr || intensityStr === 'N/A') {
    return 'intensity-level-unknown';
  }
  const className = `intensity-level-${intensityStr.replace('+', '-plus')}`;
  return className;
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

  const data = currentData

  // 計算每個警報縣市的最大震度
  const maxIntensityByCounty = React.useMemo(() => {
    if (!data.alarm || data.alarm.length === 0 || !targetStations || targetStations.length === 0) {
      return [];
    }
    const stationToCountyMap = new Map(targetStations.map(s => [s.station, s.county]));
    const alertedCounties = new Set(data.alarm.map(stationCode => stationToCountyMap.get(stationCode)).filter(Boolean));
    if (alertedCounties.size === 0) return [];

    const allReportStations = Object.keys(data).filter(key => !['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key));

    const countyIntensities = Array.from(alertedCounties).map(county => {
      let maxIntensity = '0';
      let maxIntensityValue = 0;
      allReportStations.forEach(stationCode => {
        if (stationToCountyMap.get(stationCode) === county) {
          const currentIntensity = data[stationCode];
          const currentValue = getIntensityValue(currentIntensity);
          if (currentValue > maxIntensityValue) {
            maxIntensityValue = currentValue;
            maxIntensity = currentIntensity;
          }
        }
      });
      return { county, maxIntensity };
    });

    return countyIntensities.sort((a, b) => getIntensityValue(b.maxIntensity) - getIntensityValue(a.maxIntensity));
  }, [data, targetStations]);

  // 取得本次報告的總最大震度
  const overallMaxIntensity = maxIntensityByCounty.length > 0 ? maxIntensityByCounty[0].maxIntensity : 'N/A';

  // 從報告數據創建 stationIntensities (for map)
  const reportStationIntensities = React.useMemo(() => {
    const intensities = {}
    Object.keys(data).forEach(key => {
      if (['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key)) {
        return
      }
      const intensity = data[key]
      if (intensity && intensity !== 'N/A') {
        intensities[key] = {
          intensity: intensity,
          pga: 0, // 報告中沒有PGA數據，用0代替
          color: getIntensityColor(intensity) // 新增：計算顏色
        }
      }
    })
    return intensities
  }, [data])

  // 根據當前報告的警報縣市，創建地圖填色需要的資料格式
  const countyAlertsForDetailMap = React.useMemo(() => {
    if (!maxIntensityByCounty || maxIntensityByCounty.length === 0) {
      return {};
    }
    const alerts = {};
    for (const item of maxIntensityByCounty) {
      alerts[item.county] = true;
    }
    return alerts;
  }, [maxIntensityByCounty]);

  if (!currentReport) return null

  return (
    <div className="detail-container">
      <div className="detail-header">
        <div className="detail-header-left">
          <button className="back-button" onClick={onBack}>
            ← 回上頁
          </button>
          <h2>歷史報告詳細資訊</h2>
          <span className="detail-timestamp">{currentReport.timestamp}</span>
          {selectedHistoricalReport && (
            <span className="historical-indicator">📚 歷史報告</span>
          )}
        </div>
        <div className="detail-header-right">
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
            <span className="detail-label">報告時間</span>
            <span className="detail-value">{data.report_time || 'N/A'}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">觸發測站數</span>
            <span className="detail-value">{data.picks || 0} 個</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">警報測站數</span>
            <span className="detail-value">{data.alarm ? data.alarm.length : 0} 個</span>
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

        {/* 警報縣市最大震度 */}
        {maxIntensityByCounty.length > 0 && (
          <div className="station-grid" style={{ marginTop: 'var(--spacing-sm)' }}>
            {maxIntensityByCounty.map(({ county, maxIntensity }) => (
              <div key={county} className={`station-badge ${getIntensityClassName(maxIntensity)}`}>
                {county}: {maxIntensity}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="layout-section">
        {/* 震度地圖 */}
        <div className="detail-section map-container">
          <h3>測站預測震度分布</h3>
          <div style={{ height: '400px', width: '100%', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
            <TaiwanMap
              stations={targetStations}
              stationReplacements={{}}
              stationIntensities={reportStationIntensities}
              countyAlerts={countyAlertsForDetailMap}
            />
          </div>
        </div>

        {/* 所有測站震度 */}
        <div className="detail-section stations-container">
          <h3>所有測站震度</h3>
          <div className="station-grid">
            {Object.keys(data)
              .filter(key => !['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key))
              .sort((a, b) => getIntensityValue(data[b]) - getIntensityValue(data[a]))
              .map((station, idx) => (
                <div key={idx} className={`station-badge ${getIntensityClassName(data[station])}`}>
                  {station}: {data[station] || 'N/A'}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* 原始資料 */}
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
