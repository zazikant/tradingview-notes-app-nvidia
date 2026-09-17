declare module 'pdf-parse' {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: {
      PDFFormatVersion?: string;
      IsAcroFormPresent?: boolean;
      IsXFAPresent?: boolean;
      Title?: string;
      Author?: string;
      Subject?: string;
      Keywords?: string;
      Creator?: string;
      Producer?: string;
      CreationDate?: string;
      ModDate?: string;
    };
    metadata: any;
    text: string;
    version?: string;
  }

  /**
   * pdf-parse accepts either a Buffer (file path or Buffer itself) or
   * a { data, numpages, version } shape. Most callers pass a Buffer.
   */
  function pdfParse(buffer: Buffer | Uint8Array | string): Promise<PdfData>;
  export default pdfParse;
}
