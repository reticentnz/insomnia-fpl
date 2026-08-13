import { createHash } from 'node:crypto'

const clamp=(value,min=0,max=1)=>Math.min(max,Math.max(min,Number.isFinite(Number(value))?Number(value):min))
export const normalizeEntityText=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const compact=value=>normalizeEntityText(value).replace(/\s+/g,'')
const clubCodes={arsenal:'ars','aston villa':'avl',bournemouth:'bou',brentford:'bre',brighton:'bha','brighton and hove albion':'bha',burnley:'bur',chelsea:'che','crystal palace':'cry',everton:'eve',fulham:'ful',ipswich:'ips','ipswich town':'ips',leeds:'lee','leeds united':'lee',liverpool:'liv','man city':'mci','manchester city':'mci','man united':'mun','manchester united':'mun',newcastle:'new','newcastle united':'new',sunderland:'sun',spurs:'tot',tottenham:'tot','tottenham hotspur':'tot','west ham':'whu','west ham united':'whu',wolves:'wol',wolverhampton:'wol'}
const clubKeys=value=>{
  const normalized=normalizeEntityText(value)
  const withoutSuffix=normalized.replace(/\s+(city|united|fc)$/,'').trim()
  return new Set([normalized,withoutSuffix,clubCodes[normalized],clubCodes[withoutSuffix]].filter(Boolean))
}

function clubScore(hint,value){
  const hintKeys=clubKeys(hint),valueKeys=clubKeys(value)
  if([...valueKeys].some(key=>hintKeys.has(key)))return 1
  let best=0
  for(const hintKey of hintKeys){
    for(const valueKey of valueKeys){
      if(hintKey.length>=4&&valueKey.length>=4)best=Math.max(best,similarity(hintKey,valueKey))
    }
  }
  return best
}

function editDistance(left,right){
  const row=Array.from({length:right.length+1},(_,index)=>index)
  for(let i=1;i<=left.length;i++){
    let previous=row[0];row[0]=i
    for(let j=1;j<=right.length;j++){
      const saved=row[j]
      row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(left[i-1]===right[j-1]?0:1))
      previous=saved
    }
  }
  return row[right.length]
}

function similarity(left,right){
  if(!left||!right)return 0
  if(left===right)return 1
  return clamp(1-editDistance(left,right)/Math.max(left.length,right.length))
}

function nameScore(rawName,playerName){
  const raw=normalizeEntityText(rawName),player=normalizeEntityText(playerName)
  if(!raw||!player)return 0
  if(raw===player)return 1
  const rawTokens=raw.split(' '),playerTokens=player.split(' ')
  const rawLast=rawTokens.at(-1)||raw,playerLast=playerTokens.at(-1)||player
  const tokenBest=Math.max(...rawTokens.flatMap(rawToken=>playerTokens.map(playerToken=>similarity(rawToken,playerToken))))
  const lastBest=similarity(rawLast,playerLast)
  const compactBest=similarity(compact(raw),compact(player))
  return clamp(Math.max(tokenBest*.82,lastBest*.9,compactBest*.92))
}

const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,24)

function youtubeExternalId(url){
  try{
    const parsed=new URL(url)
    if(parsed.hostname.includes('youtu.be'))return parsed.pathname.split('/').filter(Boolean)[0]||''
    return parsed.searchParams.get('v')||''
  }catch{return ''}
}

const allowedCategories=new Set(['ROLE','ROTATION','INJURY','SET_PIECES','PENALTIES','PRESEASON','TACTICS','VALUE','STATS','TRANSFER','FPL_SELECTION','OTHER'])
const allowedSentiments=new Set(['POSITIVE','NEGATIVE','MIXED','NEUTRAL'])
const allowedDepthRoles=new Set(['FIRST_CHOICE','ROTATION','BACKUP','OUT'])
const fplSelectionPattern=/\b(bench boost|my bench|gw\s*\d+\s+bench|bench goalkeeper|included[^.]*bench|my team|my squad|i(?:'m| am) going to (?:bench|start|buy|sell|own|pick)|selected as[^.]*bench)\b/i

export function normalizeCreatorPayload(payload){
  if(!payload||typeof payload!=='object')throw new Error('JSON object payload is required')
  const rawSource=payload.source&&typeof payload.source==='object'?payload.source:{}
  const url=String(rawSource.url||'').trim()
  const externalId=String(rawSource.externalId||youtubeExternalId(url)||hash(url||JSON.stringify(payload).slice(0,1000))).trim()
  const platform=String(rawSource.platform||'YOUTUBE').toUpperCase().slice(0,30)
  const source={
    platform,
    externalId:externalId.slice(0,160),
    creator:String(rawSource.creator||'Unknown creator').trim().slice(0,160),
    title:String(rawSource.title||'Untitled source').trim().slice(0,500),
    url:url.slice(0,2000),
    publishedAt:rawSource.publishedAt||null,
  }
  const rawClaims=Array.isArray(payload.claims)?payload.claims:[]
  if(!rawClaims.length)throw new Error('claims array is required')
  const claims=rawClaims.slice(0,100).map((raw,index)=>{
    if(!raw||typeof raw!=='object')return null
    const rawPlayerName=String(raw.rawPlayerName||raw.playerName||'').trim().slice(0,200)
    const summary=String(raw.summary||raw.text||'').replace(/\s+/g,' ').trim().slice(0,2000)
    if(!rawPlayerName||!summary)return null
    const suppliedCategory=allowedCategories.has(String(raw.category||'').toUpperCase())?String(raw.category).toUpperCase():'OTHER'
    const contextText=`${summary} ${raw.evidenceText||''}`
    const category=fplSelectionPattern.test(contextText)?'FPL_SELECTION':suppliedCategory
    const sentiment=allowedSentiments.has(String(raw.sentiment||'').toUpperCase())?String(raw.sentiment).toUpperCase():'NEUTRAL'
    const timestampSeconds=raw.timestampSeconds!==null&&raw.timestampSeconds!==undefined&&Number.isFinite(Number(raw.timestampSeconds))?Math.max(0,Math.round(Number(raw.timestampSeconds))):null
    const depthRole=category!=='FPL_SELECTION'&&allowedDepthRoles.has(String(raw.depthRole||'').toUpperCase())?String(raw.depthRole).toUpperCase():null
    const startProbability=category!=='FPL_SELECTION'&&typeof raw.startProbability==='number'?clamp(raw.startProbability):null
    const externalClaimId=String(raw.externalClaimId||`${source.platform}:${source.externalId}:${timestampSeconds??index}:${normalizeEntityText(rawPlayerName)}:${category}`).slice(0,300)
    return {
      externalClaimId,rawPlayerName,clubHint:raw.clubHint||raw.club||null,positionHint:raw.positionHint||null,
      priceHint:raw.priceHint!==null&&raw.priceHint!==undefined&&Number.isFinite(Number(raw.priceHint))?Number(raw.priceHint):null,category,sentiment,summary,
      evidenceText:raw.evidenceText?String(raw.evidenceText).replace(/\s+/g,' ').trim().slice(0,2000):null,
      timestampSeconds,timeHorizon:raw.timeHorizon||'UNKNOWN',numericClaims:Array.isArray(raw.numericClaims)?raw.numericClaims.slice(0,20):[],
      relatedMentions:Array.isArray(raw.relatedMentions)?raw.relatedMentions.slice(0,20):[],depthRole,startProbability,
      minutesIfStarting:category!=='FPL_SELECTION'&&typeof raw.minutesIfStarting==='number'?clamp(raw.minutesIfStarting,0,90):null,
      substituteProbabilityWhenBenched:category!=='FPL_SELECTION'&&typeof raw.substituteProbabilityWhenBenched==='number'?clamp(raw.substituteProbabilityWhenBenched):null,
      minutesIfSubstitute:category!=='FPL_SELECTION'&&typeof raw.minutesIfSubstitute==='number'?clamp(raw.minutesIfSubstitute,0,45):null,
      confidence:typeof raw.confidence==='number'?clamp(raw.confidence):null,
    }
  }).filter(Boolean)
  if(!claims.length)throw new Error('No valid claims were supplied')
  return {schemaVersion:Number(payload.schemaVersion)||1,source,claims}
}

export function matchCreatorClaim(claim,catalog,aliases=[]){
  const normalizedAlias=normalizeEntityText(claim.rawPlayerName)
  const alias=aliases.find(row=>normalizeEntityText(row.alias)===normalizedAlias)
  if(alias){
    const player=catalog.find(candidate=>Number(candidate.id)===Number(alias.playerId))
    if(player)return {status:'MATCHED',player,confidence:1,candidates:[{player,confidence:1,reasons:['verified alias']}]}
  }
  const clubHint=normalizeEntityText(claim.clubHint),positionHint=String(claim.positionHint||'').toUpperCase()
  const priceHint=Number(claim.priceHint)
  const candidates=catalog.map(player=>{
    const base=nameScore(claim.rawPlayerName,player.name)
    const bestClubScore=clubHint?Math.max(0,...[player.club,player.clubName,player.teamName].map(value=>clubScore(claim.clubHint,value))):0
    const clubMatches=bestClubScore>=.82
    const positionMatches=positionHint&&String(player.position||'').toUpperCase()===positionHint
    const priceMatches=Number.isFinite(priceHint)&&Math.abs(Number(player.price)-priceHint)<=.1
    const rankScore=base+(clubMatches?.18:0)+(positionMatches?.06:0)+(priceMatches?.05:0)
    const confidence=clamp(rankScore)
    const reasons=[`name ${Math.round(base*100)}%`]
    if(clubMatches)reasons.push('club matched')
    if(positionMatches)reasons.push('position matched')
    if(priceMatches)reasons.push('price matched')
    return {player,confidence,rankScore,reasons}
  }).filter(candidate=>candidate.confidence>=.42).sort((a,b)=>b.rankScore-a.rankScore||String(a.player.name).localeCompare(String(b.player.name))).slice(0,5)
  const best=candidates[0],runnerUp=candidates[1]
  const margin=!runnerUp?1:best.rankScore-runnerUp.rankScore
  const clubMatched=best?.reasons.includes('club matched')
  const positionMatched=best?.reasons.includes('position matched')
  const strongContext=clubMatched&&best.confidence>=.65&&margin>=(positionMatched?.1:.12)
  if(best&&(strongContext||(best.confidence>=.72&&margin>=(clubHint?.1:.15))))return {status:'MATCHED',player:best.player,confidence:best.confidence,candidates}
  if(best&&best.confidence>=.5)return {status:'AMBIGUOUS',player:null,confidence:best.confidence,candidates}
  return {status:'UNRESOLVED',player:null,confidence:best?.confidence||0,candidates}
}

export function signalDraftFromClaim(claim,playerId,source,defaultConfidence=.65){
  const value={note:claim.summary}
  for(const key of ['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole']){
    if(claim[key]!==null&&claim[key]!==undefined)value[key]=claim[key]
  }
  const categoryKinds={ROLE:'EXPECTED_ROLE',ROTATION:'DEPTH_CHART',INJURY:'INJURY',SET_PIECES:'SET_PIECES',PENALTIES:'PENALTIES',PRESEASON:'PRESEASON_MINUTES',TACTICS:'TACTICAL_ROLE',VALUE:'VALUE_OPINION',STATS:'STATISTICAL_CLAIM',TRANSFER:'TRANSFER_OPINION',FPL_SELECTION:'VALUE_OPINION',OTHER:'VALUE_OPINION'}
  const claimClasses={ROLE:'REAL_WORLD_ROLE',ROTATION:'ROTATION',INJURY:'INJURY',SET_PIECES:'SET_PIECES',PENALTIES:'PENALTIES',PRESEASON:'REAL_WORLD_ROLE',TACTICS:'REAL_WORLD_ROLE',VALUE:'VALUE_OPINION',STATS:'STATISTICAL_CONTEXT',TRANSFER:'VALUE_OPINION',FPL_SELECTION:'FPL_SELECTION',OTHER:'UNKNOWN'}
  const modelImpact=['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole'].some(key=>value[key]!=null)?'ROLE':'NONE'
  const timestampUrl=source.url&&claim.timestampSeconds!==null
    ? `${source.url}${source.url.includes('?')?'&':'?'}t=${claim.timestampSeconds}s`
    : source.url||null
  return {
    playerId,kind:categoryKinds[claim.category]||'VALUE_OPINION',value,sourceType:source.signalSourceType||'YOUTUBE_TRANSCRIPT',sourceUrl:timestampUrl,
    evidenceSummary:claim.summary,evidenceText:claim.evidenceText||claim.summary,claimClass:claimClasses[claim.category]||'UNKNOWN',modelImpact,
    interpretationRationale:modelImpact==='ROLE'?'Structured real-world role claim extracted from the source.':'Creator context only; no projection adjustment proposed.',
    confidence:claim.confidence??defaultConfidence,
  }
}

const containsEntity=(text,name)=>` ${normalizeEntityText(text)} `.includes(` ${normalizeEntityText(name)} `)
const manualSegments=text=>String(text||'').split(/;|[!?]+|\.(?=\s|$)/).map(segment=>segment.replace(/\s+/g,' ').trim()).filter(Boolean)

export function interpretManualSignalText(text,catalog){
  const byPlayer=new Map()
  for(const segment of manualSegments(text)){
    const players=catalog.filter(player=>containsEntity(segment,player.name))
    if(!players.length)continue
    const lower=segment.toLowerCase()
    const isFplChoice=fplSelectionPattern.test(segment)||/\b(i (?:like|rate|prefer)|scout (?:currently )?(?:likes|rates|prefers)|budget (?:pick|option)|buy|sell|avoid)\b/i.test(segment)
    const isBackup=/\b(not expected to be (?:the )?(?:regular|first[ -]?choice) starter|third[ -]?choice|backup goalkeeper|backup keeper|won't be (?:the )?(?:regular )?starter|will not be (?:the )?(?:regular )?starter)\b/i.test(segment)
    const isFirstChoice=/\b(first[ -]?choice|regular starter|starting goalkeeper|starting keeper|expected to start)\b/i.test(segment)&&!isBackup
    const isReduced=/\b(reduced minutes|minutes (?:risk|concern)|share minutes|rotation risk|rotated)\b/i.test(segment)
    const isUnavailable=/\b(ruled out|unavailable|will miss|set to miss)\b/i.test(segment)
    const isInjury=/\b(injur|hamstring|knock|fitness|doubt|missed training)\b/i.test(segment)
    const hasMeaning=isFplChoice||isBackup||isFirstChoice||isReduced||isUnavailable||isInjury
    if(players.length>1&&!hasMeaning)continue
    for(const player of players){
      let draft
      if(isBackup){
        draft={playerId:player.id,kind:'DEPTH_CHART',claimClass:'REAL_WORLD_ROLE',modelImpact:'ROLE',value:{depthRole:'BACKUP',startProbability:.08,minutesIfStarting:player.position==='GK'?90:82,substituteProbabilityWhenBenched:player.position==='GK'?.005:.2,minutesIfSubstitute:player.position==='GK'?5:18,note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'The statement explicitly says the player is not expected to be the regular starter.',confidence:.8,status:'PENDING'}
      }else if(isFirstChoice){
        draft={playerId:player.id,kind:'DEPTH_CHART',claimClass:'REAL_WORLD_ROLE',modelImpact:'ROLE',value:{depthRole:'FIRST_CHOICE',startProbability:.88,minutesIfStarting:player.position==='GK'?90:84,note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'The statement explicitly describes the player as a regular or first-choice starter.',confidence:.75,status:'PENDING'}
      }else if(isReduced){
        draft={playerId:player.id,kind:'EXPECTED_ROLE',claimClass:'ROTATION',modelImpact:'ROLE',value:{depthRole:'ROTATION',startProbability:.55,note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'The statement describes reduced minutes or rotation risk.',confidence:.6,status:'PENDING'}
      }else if(isUnavailable){
        draft={playerId:player.id,kind:'INJURY',claimClass:'INJURY',modelImpact:'ROLE',value:{depthRole:'OUT',startProbability:0,note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'The statement explicitly says the player is unavailable.',confidence:.75,status:'PENDING'}
      }else if(isInjury){
        draft={playerId:player.id,kind:'INJURY',claimClass:'AVAILABILITY',modelImpact:'NONE',value:{note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'An availability concern is mentioned, but its numerical impact is ambiguous.',confidence:.55,status:'PENDING'}
      }else if(isFplChoice){
        draft={playerId:player.id,kind:'VALUE_OPINION',claimClass:/\bbench|my team|my squad\b/i.test(lower)?'FPL_SELECTION':'CREATOR_RATING',modelImpact:'NONE',value:{note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'This is an FPL selection or creator preference, not evidence about the player’s real-world minutes.',confidence:.8,status:'VERIFIED'}
      }else{
        draft={playerId:player.id,kind:'VALUE_OPINION',claimClass:'UNKNOWN',modelImpact:'NONE',value:{note:segment},evidenceSummary:segment,evidenceText:segment,interpretationRationale:'The player is mentioned, but the model impact is ambiguous.',confidence:.4,status:'PENDING'}
      }
      const existing=byPlayer.get(player.id)
      const priority=item=>item.modelImpact==='ROLE'?3:item.claimClass==='UNKNOWN'||item.claimClass==='AVAILABILITY'?2:1
      if(!existing||priority(draft)>priority(existing))byPlayer.set(player.id,draft)
    }
  }
  return [...byPlayer.values()]
}
