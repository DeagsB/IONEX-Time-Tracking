declare module 'html2pdf.js' {
  interface Html2PdfOptions {
    margin?: number | number[];
    filename?: string;
    image?: { type?: string; quality?: number };
    html2canvas?: {
      scale?: number;
      useCORS?: boolean;
      logging?: boolean;
      [key: string]: unknown;
    };
    jsPDF?: {
      unit?: string;
      format?: string | number[];
      orientation?: 'portrait' | 'landscape';
      [key: string]: unknown;
    };
    pagebreak?: { mode?: string | string[] };
  }

  interface Html2Pdf {
    set(options: Html2PdfOptions): Html2Pdf;
    from(element: Element | null): Html2Pdf;
    save(): Promise<void>;
    outputPdf(type?: string): Promise<unknown>;
    then(callback: (pdf: unknown) => void): Html2Pdf;
  }

  function html2pdf(): Html2Pdf;
  export = html2pdf;
}

