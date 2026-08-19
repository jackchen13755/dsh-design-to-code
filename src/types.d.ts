declare module '@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js' {
  export function decodeFrameAndBuildReport(
    dataFramePath: string,
    fileKey: string,
    nodeId: string,
    outDir: string,
  ): { jsonPath: string; mdPath: string; nodeCount: number; messageType: string }
}
