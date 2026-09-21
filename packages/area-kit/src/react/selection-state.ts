import type {DatasetSummary, Level, Page, RegionSummary, SelectionResult} from "../types.js";

export interface LayerState {
  parentCode: string | null;
  items: RegionSummary[];
  phase: "unloaded" | "loading" | "loaded" | "error";
  requestId: number;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
}

export interface SelectionState {
  generation: number;
  dataset: DatasetSummary | null;
  path: RegionSummary[];
  layers: LayerState[];
  status: SelectionResult | null;
  disabled: boolean;
  targetLevel: Level;
  policyKey: string;
  valueKey: string;
}

export type SelectionAction =
  | {type: "props"; disabled: boolean; targetLevel: Level; policyKey: string; valueKey: string}
  | {type: "dataset"; generation: number; dataset: DatasetSummary}
  | {type: "choose"; node: RegionSummary}
  | {type: "clear"}
  | {type: "lifecycle"; generation: number}
  | {type: "hydrate"; generation: number; path: RegionSummary[]}
  | {type: "start"; generation: number; layerIndex: number; requestId: number}
  | {type: "loaded"; generation: number; layerIndex: number; requestId: number; parentCode: string | null; page: Page<RegionSummary>}
  | {type: "failed"; generation: number; layerIndex: number; requestId: number; message: string}
  | {type: "status"; generation: number; result: SelectionResult | null};

function layer(parentCode: string | null): LayerState {
  return {parentCode,items:[],phase:"unloaded",requestId:0,hasMore:false,nextCursor:null,error:null};
}

function layersFor(path: readonly RegionSummary[]): LayerState[] {
  return [layer(null),...path.map(node=>layer(node.code))];
}

function layersAfterChoose(state: SelectionState, path: readonly RegionSummary[], node: RegionSummary): LayerState[] {
  const ancestors=path.slice(0,-1);
  const retained=Array.from({length:node.level},(_,index) => {
    const parentCode=index===0 ? null : ancestors[index-1]?.code ?? null;
    const current=state.layers[index];
    return current?.parentCode===parentCode ? current : layer(parentCode);
  });
  return [...retained,layer(node.code)];
}

export function initialSelectionState(input: {disabled: boolean; targetLevel: Level; policyKey: string; valueKey?: string}): SelectionState {
  return {generation:0,dataset:null,path:[],layers:layersFor([]),status:null,disabled:input.disabled,targetLevel:input.targetLevel,
    policyKey:input.policyKey,valueKey:input.valueKey ?? ""};
}

function changedProps(state: SelectionState, action: Extract<SelectionAction,{type:"props"}>): boolean {
  return state.disabled!==action.disabled || state.targetLevel!==action.targetLevel || state.policyKey!==action.policyKey || state.valueKey!==action.valueKey;
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "props":
      if (!changedProps(state,action)) return state;
      if (state.valueKey!==action.valueKey && action.valueKey==="") {
        return {...state,generation:state.generation+1,path:[],layers:layersFor([]),status:null,disabled:action.disabled,
          targetLevel:action.targetLevel,policyKey:action.policyKey,valueKey:action.valueKey};
      }
      return {...state,generation:state.generation+1,status:null,disabled:action.disabled,targetLevel:action.targetLevel,
        policyKey:action.policyKey,valueKey:action.valueKey};
    case "dataset":
      return action.generation===state.generation ? {...state,dataset:action.dataset} : state;
    case "choose": {
      const path=[...state.path.filter(item=>item.level<action.node.level),action.node];
      return {...state,generation:state.generation+1,path,layers:layersAfterChoose(state,path,action.node),status:null};
    }
    case "clear":
      return {...state,generation:state.generation+1,path:[],layers:layersFor([]),status:null};
    case "lifecycle":
      return action.generation===state.generation+1 ? {...state,generation:action.generation} : state;
    case "hydrate":
      return action.generation===state.generation ? {...state,path:action.path,layers:layersFor(action.path),status:null} : state;
    case "start": {
      if (action.generation!==state.generation) return state;
      const current=state.layers[action.layerIndex];
      if (!current) return state;
      const layers=state.layers.slice();
      layers[action.layerIndex]={...current,phase:"loading",requestId:action.requestId,error:null};
      return {...state,layers};
    }
    case "loaded": {
      const current=state.layers[action.layerIndex];
      if (action.generation!==state.generation || !current || action.requestId!==current.requestId || action.parentCode!==current.parentCode) return state;
      const unique=new Map(current.items.map(item=>[item.code,item]));
      for (const item of action.page.items) unique.set(item.code,item);
      const layers=state.layers.slice();
      layers[action.layerIndex]={...current,items:[...unique.values()],phase:"loaded",error:null,
        hasMore:action.page.hasMore,nextCursor:action.page.nextCursor};
      return {...state,layers};
    }
    case "failed": {
      const current=state.layers[action.layerIndex];
      if (action.generation!==state.generation || !current || action.requestId!==current.requestId) return state;
      const layers=state.layers.slice();
      layers[action.layerIndex]={...current,phase:"error",error:action.message};
      return {...state,layers};
    }
    case "status":
      return action.generation===state.generation ? {...state,status:action.result} : state;
  }
}
