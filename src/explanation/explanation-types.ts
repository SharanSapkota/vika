
import type { RedactionKind } from "../redaction/redaction-kinds.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";


export interface ExplanationFrame {
  filePath: string;
  lineNumber: number;
  functionName: string | null;
}


export interface ExplanationRegression {
  exceptionType: string | null;
  message: string; 
  topFrames: ExplanationFrame[];
}


export interface SuspectDiff {
  commitSha: string;
  diffText: string | null; 
  problem: string | null; 
}

export interface ExplanationRequestInput {
  regression: ExplanationRegression;
  suspects: Suspect[]; 
  suspectDiffs: SuspectDiff[];
  maxDiffLines: number;
  redactionKinds: readonly RedactionKind[];
  secrets: string[]; 
}

export interface ExplanationRequest {
  promptText: string; 
  
  leftOutNotes: string[];
}



export interface Explanation {
  model: string;
  answerText: string;
}
