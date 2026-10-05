// Run once after the large-case screenshots are on GitHub Pages: switches the preference form
// to the node-express-boilerplate session (two pictures per view). The share link stays the same.
function updatePreferenceToLarge() {
  const form = FormApp.openById("1IvP0r15qMIpB6xZfDvpzeXZe5lTW4Ddc3phv_gtLzb0")
  if (form.getItems().filter((i) => i.getType() === FormApp.ItemType.IMAGE).length > 2) throw new Error("already updated")
  const base = "https://basartemiz.github.io/opencode/study"
  const shot = (name) => UrlFetchApp.fetch(base + "/media-large/screenshots/" + name).getBlob()
  form.setTitle("Which view would you rather use? (2 min)")
  form.setDescription(
    "An AI coding agent (OpenCode) worked on a real 50-file Node.js API. Its task: add soft delete for users " +
    "(deleted users are hidden and cannot log in, admins can restore them). It changed 7 files. " +
    "Below are two ways to review what it did. Look at the pictures and answer a few quick questions. " +
    "No names or emails are collected."
  )
  const images = form.getItems(FormApp.ItemType.IMAGE).map((i) => i.asImageItem())
  images[0].setTitle("View 1: the agent's final summary and the list of changed files")
    .setHelpText("Full page: " + base + "/survey-large/A.html")
    .setImage(shot("large-01-today-summary-and-files.png"))
  const v1b = form.addImageItem().setTitle("View 1, continued: the diff of each file")
    .setImage(shot("large-01b-today-diff.png"))
  form.moveItem(v1b.getIndex(), images[0].getIndex() + 1)
  images[1].setTitle("View 2: how the change flows through the code, checked against the real imports")
    .setHelpText("Full page: " + base + "/survey-large/B.html")
    .setImage(shot("large-03-map-flow.png"))
  const v2b = form.addImageItem().setTitle("View 2, continued: files that were not changed but may be affected")
    .setImage(shot("large-04-map-may-be-affected.png"))
  form.moveItem(v2b.getIndex(), images[1].getIndex() + 1)
  Logger.log(form.getItems().map((i, n) => n + " " + i.getType() + " " + i.getTitle()).join("\n"))
}
