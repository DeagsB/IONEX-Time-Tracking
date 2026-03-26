export interface OptimizeImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.0 to 1.0
  mimeType?: string; // e.g. 'image/jpeg' or 'image/webp'
}

/**
 * Optimizes an image file by resizing and compressing it.
 * Ideal for reducing the size of high-res phone camera photos before upload.
 */
export async function optimizeImage(file: File, options: OptimizeImageOptions = {}): Promise<File> {
  const {
    maxWidth = 1600,
    maxHeight = 1600,
    quality = 0.8,
    mimeType = 'image/jpeg',
  } = options;

  // Ensure we are only trying to optimize images
  if (!file.type.startsWith('image/')) {
    return file;
  }
  
  // Don't optimize svgs or gifs as canvas conversion might ruin them
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    return file;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Calculate new dimensions
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        if (height > maxHeight) {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }

        // Create canvas and draw image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          reject(new Error('Could not get 2D context'));
          return;
        }
        
        // Fill with white background in case it's a transparent PNG converted to JPEG
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to blob
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Canvas to Blob conversion failed'));
              return;
            }
            // Create a new file with the optimized blob
            // Using a unique timestamp to prevent caching issues if needed, or keeping original name
            const ext = mimeType === 'image/webp' ? '.webp' : '.jpg';
            const newFileName = file.name.replace(/\.[^/.]+$/, "") + ext;
            const optimizedFile = new File([blob], newFileName, {
              type: mimeType,
              lastModified: Date.now(),
            });
            resolve(optimizedFile);
          },
          mimeType,
          quality
        );
      };
      
      img.onerror = () => {
        reject(new Error('Failed to load image for optimization'));
      };
      
      if (typeof e.target?.result === 'string') {
        img.src = e.target.result;
      } else {
        reject(new Error('FileReader result is not a string'));
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    
    reader.readAsDataURL(file);
  });
}
