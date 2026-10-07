import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { BarChart3, Split } from 'lucide-react';

export const AnalysisNode = ({ data, isConnectable }) => {
  const isComparison = data.type === 'metric_compare';
  const typeLabel = isComparison ? 'Metric Comparison' : 'Dimension Breakdown';
  
  // Metric Compare Data
  const metrics = data.metrics || (data.metric ? [data.metric] : []);

  // Dimension Breakdown Data
  const dimensions = data.dimensions || (data.dimension ? [data.dimension] : []);
  const baseMetrics = Array.isArray(data.base_metrics) && data.base_metrics.length
    ? data.base_metrics
    : (data.base_metric ? [data.base_metric] : []);

  return (
    <div className="w-[250px] bg-white border-2 border-blue-400 rounded-lg shadow-sm">
        <div className="bg-blue-50 px-3 py-2 border-b border-blue-200 rounded-t-lg flex items-center gap-2">
            {isComparison ? <BarChart3 className="w-4 h-4 text-blue-600" /> : <Split className="w-4 h-4 text-blue-600" />}
            <span className="text-sm font-medium text-blue-900 line-clamp-1" title={data.id}>{data.id}</span>
        </div>
        
        <div className="p-3 text-xs text-gray-600">
            <div className="font-semibold text-blue-700 mb-1">{!isComparison && data.analysis_mode === 'inventory' ? 'Inventory Breakdown' : typeLabel}</div>
            
            {/* Metric Compare View */}
            {isComparison && metrics.length > 0 && (
                 <div className="flex flex-wrap gap-1">
                    {metrics.map(m => (
                        <span key={m} className="bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded text-[10px]">{m}</span>
                    ))}
                </div>
            )}

            {/* Dimension Breakdown View */}
            {!isComparison && data.analysis_mode === 'inventory' && (
                <div className="space-y-1 text-[10px]">
                    <div>Top {data.inventory_top_k || 50} products by 7-day sales</div>
                    <div>Report shows {data.inventory_report_top_k || 2} lowest-DOH products</div>
                    <div>Critical ≤ {data.critical_doh_days ?? 7} DOH · Healthy ≥ {data.healthy_doh_days ?? 15} DOH</div>
                </div>
            )}
            {!isComparison && data.analysis_mode !== 'inventory' && (
                <div className="space-y-1">
                    {baseMetrics.length > 0 && (
                        <div className="flex items-center gap-1">
                            <span className="text-gray-400 text-[10px]">Metrics:</span>
                            <div className="flex flex-wrap gap-1">
                              {baseMetrics.map((metric) => (
                                <span key={metric} className="font-mono bg-gray-100 px-1 rounded">{metric}</span>
                              ))}
                            </div>
                        </div>
                    )}
                    {dimensions.length > 0 && (
                        <div>
                             <span className="text-gray-400 text-[10px] block mb-0.5">Dims:</span>
                             <div className="flex flex-wrap gap-1">
                                {dimensions.slice(0, 3).map(d => (
                                    <span key={d} className="bg-indigo-50 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 rounded text-[10px]">{d}</span>
                                ))}
                                {dimensions.length > 3 && <span className="text-[10px] text-gray-400">+{dimensions.length - 3}</span>}
                             </div>
                        </div>
                    )}
                </div>
            )}
        </div>

        <Handle type="target" position={Position.Top} isConnectable={isConnectable} />
        <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} />
    </div>
  );
};
