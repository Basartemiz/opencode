// Short preference form (about 2 minutes). Run createPreferenceForm() once.
// Images are the study screenshots published on GitHub Pages.
const PAGES = "https://basartemiz.github.io/opencode/study"

function createPreferenceForm() {
  const form = FormApp.create("Which view would you rather use? (2 min)")
  form.setDescription(
    "An AI coding agent added four small features to a project. Below are two ways to see what it changed. " +
    "Look at both pictures and answer a few quick questions. No names or emails are collected."
  )
  form.setCollectEmail(false)

  form.addMultipleChoiceItem().setTitle("Which describes you best?")
    .setChoiceValues(["CS / engineering student", "Working developer", "Other"]).setRequired(true)
  form.addMultipleChoiceItem().setTitle("How often do you use AI coding agents (Claude Code, Cursor, Copilot, OpenCode...)?")
    .setChoiceValues(["Never", "Sometimes", "Every day"]).setRequired(true)

  const image = (path) => UrlFetchApp.fetch(PAGES + path).getBlob()
  form.addImageItem().setTitle("View 1: the agent's final summary and the diff of every file")
    .setHelpText("Full page: " + PAGES + "/survey/A.html")
    .setImage(image("/media/screenshots/01-today-final-diff.png"))
  form.addImageItem().setTitle("View 2: a map of each step, checked against the real code")
    .setHelpText("Full page: " + PAGES + "/survey/B.html")
    .setImage(image("/media/screenshots/03-map-flow-checked-against-imports.png"))

  form.addMultipleChoiceItem().setTitle("If an AI agent changed your code, which view would you rather check it with?")
    .setChoiceValues(["View 1", "View 2", "No preference"]).setRequired(true)
  form.addMultipleChoiceItem().setTitle("In which view would you find faster where a change happened?")
    .setChoiceValues(["View 1", "View 2", "About the same"]).setRequired(true)
  form.addScaleItem().setTitle("Would you use View 2 while an AI agent writes code for you?")
    .setBounds(1, 5).setLabels("Not at all", "Definitely").setRequired(true)
  form.addTextItem().setTitle("Why? (one line, optional)").setRequired(false)

  const sheet = SpreadsheetApp.create("Preference survey responses")
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId())
  Logger.log("Share link: " + form.getPublishedUrl())
  Logger.log("Edit link:  " + form.getEditUrl())
  Logger.log("Responses:  " + sheet.getUrl())
}
