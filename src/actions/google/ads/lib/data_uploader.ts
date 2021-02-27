import * as crypto from "crypto"
import * as lodash from "lodash"
import * as oboe from "oboe"
import { Readable } from "stream"
import { GoogleAdsActionWorker } from "./ads_worker"

const BATCH_SIZE = 10 * 1000

export class GoogleAdsUserListUploader {

  private doHashing: boolean
  private queue: any[] = []
  private apiPromises: Promise<any>[] = []
  private isSchemaDetermined = false
  private schema: {[s: string]: string} = {}

  /*
   * If the Looker column label matches the regex, that label will be added to the schema object
   * with its value set to the corresponding output property path given below.
   * Then when subsequent rows come through, we use the schema object keys to get the columns we care about,
   * and put those values into the corresponding output path, as given by the schema object values.
   *
   * Example 1st row: {"User Email Address": "lukeperry@example.com", "US Zipcode": "90210"}
   * Schema object: {"User Email Address": "hashed_email", "US Zipcode": "address_info.postal_code"}
   * Parsed result: [{"hashed_email": "lukeperry@example.com"}, {"address_info": {"postal_code": "90210"}}]
   *                                   ^^^^^^^ Except the email could actually be a hash
   */
  private regexes = [
    [/email/i, "hashed_email"],
    [/phone/i, "hashed_phone_number"],
    [/first/i, "address_info.hashed_first_name"],
    [/last/i, "address_info.hashed_last_name"],
    [/city/i, "address_info.city"],
    [/state/i, "address_info.state"],
    [/country/i, "address_info.country_code"],
    [/postal|zip/i, "address_info.postal_code"],
  ]

  constructor(readonly adsWorker: GoogleAdsActionWorker) {
    this.doHashing = adsWorker.doHashing
  }

  private get batchIsReady() {
    return this.queue.length > BATCH_SIZE
  }

  private get numBatches() {
    return this.apiPromises.length
  }

  async run() {
    try {
      // The ActionRequest.prototype.stream() method is going to await the callback we pass
      // and either resolve the result we return here, or reject with an error from anywhere
      await this.adsWorker.hubRequest.stream(async (downloadStream) => {
        return this.startAsyncParser(downloadStream)
      })
    } catch (errorReport) {
      // TODO: the oboe fail() handler sends an errorReport object, but that might not be the only thing we catch
      this.adsWorker.log("error", "Streaming parse failure:", errorReport.toString())
    }
    await Promise.all(this.apiPromises)
    this.adsWorker.log("info",
      `Streaming upload complete. Sent ${this.numBatches} batches (batch size = ${BATCH_SIZE})`,
    )
  }

  private async startAsyncParser(downloadStream: Readable) {
    return new Promise<void>((resolve, reject) => {
      oboe(downloadStream)
        .node("!.*", (row: any) => {
          if (!this.isSchemaDetermined) {
            this.determineSchema(row)
          }
          this.handleRow(row)
          this.sendIfBatch()
          return oboe.drop
        })
        .done(() => {
          this.sendIfBatch(true)
          resolve()
        })
        .fail(reject)
    })
  }

  private determineSchema(row: any) {
    for (const columnLabel of Object.keys(row)) {
      for (const mapping of this.regexes) {
        const [regex, outputPath] = mapping
        if (columnLabel.match(regex)) {
          this.schema[columnLabel] = outputPath as string
        }
      }
    }
    this.isSchemaDetermined = true
  }

  private handleRow(row: any) {
    const output = this.transformRow(row)
    this.queue.push(...output)
  }

  private transformRow(row: any) {
    const schemaMapping = Object.entries(this.schema)
    const outputCells = schemaMapping.map(( [columnLabel, outputPath] ) => {
      let outputValue = row[columnLabel]
      if (this.doHashing && outputPath.includes("hashed")) {
        outputValue = this.normalizeAndHash(outputValue)
      }
      return lodash.set({} as any, outputPath, outputValue)
    })
    return outputCells
  }

  // Formatting guidelines: https://support.google.com/google-ads/answer/7476159?hl=en
  private normalizeAndHash(rawValue: string) {
    const normalized = rawValue.trim().toLowerCase()
    const hashed = crypto.createHash("sha256").update(normalized).digest("hex")
    return hashed
  }

  private sendIfBatch(force = false) {
    if ( !this.batchIsReady && !force ) {
      return
    }
    const batch = this.queue.splice(0, BATCH_SIZE - 1)
    const apiPromise = this.adsWorker.addDataJobOperations(batch)
    this.apiPromises.push(apiPromise)
  }

}