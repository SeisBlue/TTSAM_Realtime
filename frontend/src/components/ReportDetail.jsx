import React from 'react'
import PropTypes from 'prop-types'

export default function ReportDetail({ report, onBack }) {
  if (!report) return null

  const data = report.data

  return (
    <div className="detail-container">
      <div className="detail-header">
        <div className="detail-header-left">
          <h2>📊 預測報告詳細資訊</h2>
          <span className="detail-timestamp">{report.timestamp}</span>
        </div>
        <button className="back-button" onClick={onBack}>
          ← 回上頁
        </button>
      </div>

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
  onBack: PropTypes.func.isRequired
}
