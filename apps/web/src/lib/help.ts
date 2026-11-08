/**
 * M38-T3: what each control of the editors is for, and where what it sets is used: shown as its tooltip, and beside the
 * headings that have an info icon. One place, so the sentences stay alike.
 */
export const HELP = {
  // The App.
  appName: "The App's name. Pipelines belong to it by writing it in `app:`; its pages are under it in the menu.",
  appIcon: "The App's icon: in the menu beside its pages, and on the Apps page.",
  appDescription: "What the App keeps, in a sentence. Shown on the App's page, and read by the builder when it proposes changes to it.",

  // Types and fields.
  typeName: "The type's name: a capital letter, then letters and digits. Pipelines save and read it by this name (data.save, data.read).",
  typeMine: "A type of mine: I add, change and delete its entities on its pages; pipelines only read them.",
  typeKey: "The field that tells one entity from another. A pipeline saving the same key again updates that entity instead of adding one.",
  typeTitle: "The field that names an entity: the link on its list, the heading of its page. By default its key.",
  typeDescription: "What one of them is, in a sentence. The builder reads it when it drafts pipelines or changes the type.",
  newType: "A new type's name: a capital letter, then letters and digits (Job, Bill, Product).",
  fieldName: "The field's name, as pipelines write it. Renaming it renames it on the App's pages too.",
  fieldKind: "How its value is read and shown: text, long text, a number, money, a date, a link, an email, yes/no, a choice, a list.",
  fieldLabel: "Its name on the pages. Left empty, it is made from the field's name (dueDate → Due date).",
  fieldRequired: "Required: a pipeline's save without it is refused, so every entity has it.",
  fieldMine: "Mine: I set it on the entity's page; pipelines never write it (my notes, a rating, a choice of mine).",
  fieldValues: "The choices it can be, separated by commas. They are also its filter's values.",
  fieldCurrency: "The text field that holds its currency (EUR, BGN). Totals are summed per currency.",
  newField: "A new field's name: a letter, then letters, digits, _ or -.",
  newFieldKind: "The new field's kind; it can be changed afterwards.",

  // Stages.
  stageField: "The field that holds where each entity is. It is a choice of the states below; pipelines and I move it along the arrows.",
  stateName: "A state's name. Renaming it renames it in its moves and on the pages.",
  newState: "A new state's name. Draw a move to it by dragging from another state.",
  moveFrom: "The state the move starts from.",
  moveTo: "The state the move goes to.",
  moveByMe: "I may make this move with a button on the entity's page.",
  moveByPipeline: "A pipeline may make this move when it saves the entity (data.save with a stage).",

  // Pages.
  pageMenu: "Shown in the menu under Pages. Off: reached only from the App's page.",
  pageMenuLabel: "Its name in the menu; by default the type's name.",
  pageMenuIcon: "Its icon in the menu; by default the App's.",
  pageColumns: "The columns of the list, in order: move them with the arrows, add one from the list. At most 8.",
  pageDue: "A date column's badge: overdue, today, or in N days; not shown while the entity is as 'unless' says (paid).",
  pageDueDays: "How many days before the date the badge shows.",
  pageFilters: "Choice and yes/no fields to filter the list by, above it.",
  pageSearch: "The fields the list's search box looks in.",
  pageSort: "The order of the list.",
  pageGroup: "Rows in groups by this field, each with its count and totals; a date by its month or year.",
  pageTotals: "Number and money fields summed in each group.",
  pageWhenTotal: "A total of only some entities of each group, e.g. Unpaid: the amount of those whose status is due.",
  pageMoves: "On each row, a button for each stage move I may make from where it is (Mark paid).",
  pageRemoved: "A Removed tab: the entities a pipeline's complete save no longer found.",
  pageSection: "A section of the entity's own page: its title and the fields under it.",
  pageViewFields: "The fields on the entity's own page, in order.",
  pageFormFields: "The fields I fill in on the entity's form (my fields).",

  // Pipelines and their steps.
  pipelineName: "The pipeline's name: in the menu, on its runs, and how other pipelines and buttons start it.",
  pipelineApp: "The App whose types its steps save and read. Without one, it keeps nothing of an App.",
  allowedSites:
    "The sites its steps may read from (its policy's allowedDomains). A step reading another site asks to allow it on its card.",
  pipelineDescription: "What it does, in a sentence. The builder reads it when it changes the pipeline.",
  stepSearch: "Find a step by what it does or its type.",
  stepId: "The step's name. Later steps use what it gives as {{name.field}}; renaming it renames those too.",
  stepWhen: "Only when…: the step runs only when this has something (not empty, not false, not 0); else it is skipped.",
  stepForEach: "For each…: the step runs once for each item of this list; {{item}} is the one it is on.",
  stepCredential: "A saved credential, written as {{cred:name}}: its secret is never shown or kept in the pipeline.",
  stepInput: "An input of this step.",

  // Triggers.
  triggerKind: "What starts the pipeline: I by hand, a schedule, something that happens in AI ME, or a call from the Internet.",
  scheduleTimes: "The times of day it starts, as 08:00, 18:30.",
  scheduleCron: "The schedule as a cron expression (minute hour day month weekday): what the days and times above write.",
  scheduleTz: "The time zone its times are in.",
  webhookCheck: "How a call proves it is from who I gave the address to: a signature over its body, or a token in its header.",
  eventOn: "Which happening in AI ME starts it.",
  eventOption: "Only some of those happenings: leave it empty for all of them.",
  eventLabels: "Only emails with these labels, separated by commas.",
  eventSite: "Only recipes of this site.",
} as const;

export type HelpKey = keyof typeof HELP;
