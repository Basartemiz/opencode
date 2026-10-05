// Run once: swaps the four form pictures for tight, readable crops (the form column is narrow).
function useCroppedImages() {
  const form = FormApp.openById("1IvP0r15qMIpB6xZfDvpzeXZe5lTW4Ddc3phv_gtLzb0")
  const base = "https://basartemiz.github.io/opencode/study/media-large/screenshots/"
  const crops = [
    ["View 1: ", "form-1a-summary.png"],
    ["View 1, continued", "form-1b-diff.png"],
    ["View 2: ", "form-2a-flow.png"],
    ["View 2, continued", "form-2b-affected.png"],
  ]
  const images = form.getItems(FormApp.ItemType.IMAGE).map((i) => i.asImageItem())
  crops.forEach(([prefix, file]) => {
    const item = images.find((i) => i.getTitle().startsWith(prefix))
    if (!item) throw new Error("no image titled " + prefix)
    item.setImage(UrlFetchApp.fetch(base + file).getBlob())
  })
  images.find((i) => i.getTitle().startsWith("View 1, continued")).setTitle("View 1, continued: the diff of each file (one of the 7 files shown)")
  images.find((i) => i.getTitle().startsWith("View 2: ")).setHelpText("Full page: https://basartemiz.github.io/opencode/study/survey-large/B.html (one of the agent's checkpoints shown)")
  Logger.log("swapped " + crops.length + " images")
}
