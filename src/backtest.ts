import type { Position } from './domain'

export type BacktestRow={position:Position;expectedPoints:number;actualPoints:number}
export type CalibrationResult={position:Position|'ALL';sampleSize:number;factor:number;mae:number;rmse:number;bias:number}

const round=(value:number,digits=3)=>+value.toFixed(digits)
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))

function summarize(position:Position|'ALL',rows:BacktestRow[]):CalibrationResult {
  if(!rows.length)return {position,sampleSize:0,factor:1,mae:0,rmse:0,bias:0}
  const errors=rows.map(row=>row.expectedPoints-row.actualPoints)
  const predicted=rows.reduce((sum,row)=>sum+row.expectedPoints,0)
  const actual=rows.reduce((sum,row)=>sum+row.actualPoints,0)
  return {position,sampleSize:rows.length,factor:round(clamp(predicted>0?actual/predicted:1,.75,1.25),4),mae:round(errors.reduce((sum,error)=>sum+Math.abs(error),0)/rows.length),rmse:round(Math.sqrt(errors.reduce((sum,error)=>sum+error*error,0)/rows.length)),bias:round(errors.reduce((sum,error)=>sum+error,0)/rows.length)}
}

export function evaluateCalibration(rows:BacktestRow[]):CalibrationResult[] {
  return ['GK','DEF','MID','FWD'].map(position=>summarize(position as Position,rows.filter(row=>row.position===position))).concat(summarize('ALL',rows))
}
