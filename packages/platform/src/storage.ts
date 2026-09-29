import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Evidence storage. Files never pass through our servers: the API hands the browser a short-lived
 * presigned URL and the browser talks to S3 directly (HLD §8, "S3 presigned uploads").
 */
export class ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly cfg: StorageConfig) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      // Local S3 stand-ins serve buckets as paths, not subdomains.
      forcePathStyle: true,
      // The SDK otherwise signs a CRC32 of the (empty) body into presigned URLs, so every real upload
      // fails with BadDigest. Checksums are only added when an operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  /** Creates the bucket on first start in local development. In AWS the bucket comes from Terraform. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
    }
  }

  /**
   * The signature covers content type and length, so the upload must match exactly what the API
   * validated: a client cannot request a URL for a 1 MB PNG and then upload 5 GB of something else.
   */
  presignUpload(key: string, contentType: string, sizeBytes: number): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    return getSignedUrl(this.client, cmd, {
      expiresIn: 600,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  /** Server-side write, for files a worker produces itself (automated run traces and screenshots). */
  async write(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  /**
   * Reads a whole object into memory, for server-side forwarding (evidence attached to Jira). Callers
   * check the size first: evidence is capped at 100 MB by the upload rules.
   */
  async read(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    return res.Body.transformToByteArray();
  }

  presignDownload(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: 3600,
    });
  }
}
