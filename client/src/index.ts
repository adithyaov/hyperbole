import { patch, create } from "omdomdom/lib/omdomdom.es.js"
import { SocketConnection } from './sockets'
import { listenChange, listenClick, listenDblClick, listenFormSubmit, listenLoad, listenLoadDocument, listenInput, listenKeydown, listenKeyup } from './events'
import { actionMessage, ActionMessage } from './action'
import { setQuery } from "./browser"


// import { listenEvents } from './events';
// import { WEBSOCKET_ADDRESS, Messages } from './Messages'
// import { INIT_PAGE, INIT_STATE, State, Class } from './types';
// import { fromVDOM, VDOM } from './vdom'


// const CONTENT_ID = "yeti-root-content"

// console.log("VERSION 2", INIT_PAGE, INIT_STATE)
console.log("Hyperbole 0.4.3d")


let rootStyles: HTMLStyleElement;
let addedRulesIndex = new Set();


async function sendAction(msg: ActionMessage) {
  async function sendActionHttp(msg: ActionMessage) {
    // console.log("HTTP sendAction", msg.url.toString())

    let res = await fetch(msg.url, {
      method: "POST",
      headers: { 'Accept': 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: msg.form,
      // we never want this to be redirected
      redirect: "manual"
    })

    if (res.headers.get('location')) {
      // manual redirect with status 200
      console.log("Found Redirect", res.headers.get('location'))
      window.location.href = res.headers.get('location')
      return
    }


    if (res.headers.get("location")) {
      window.location.href = res.headers.get("location")
      return
    }

    if (res.headers.has("set-query")) {
      setQuery(res.headers.get("set-query"))
    }

    if (!res.ok) {
      let error = new Error()
      error.name = "Fetch Error " + res.status
      let body = await res.text()
      error.message = body
      throw error
    }

    return res.text()
  }

  if (sock.isConnected) {
    return sock.sendAction(msg)
  }
  else {
    return sendActionHttp(msg)
  }
}




async function fetchAction(msg: ActionMessage): Promise<string> {
  try {
    let ret = await sendAction(msg)
    return ret
  }
  catch (err) {
    // handle error here
    document.body.innerHTML = errorHTML(err)
    throw err

  }
}

async function runAction(target: HTMLElement, action: string, form?: FormData) {

  if (action === undefined) {
    console.error("Undefined Action!", target, "this is a bug, please report: https://github.com/seanhess/hyperbole")
    return
  }

  let timeout = setTimeout(() => {
    // add loading after 100ms, not right away
    // if it runs shorter than that we probably don't want to add loading effects
    target.classList.add("hyp-loading")
  }, 100)

  let msg = actionMessage(target.id, action, form)

  // console.log("FETCH", target.id, action)
  let ret = await fetchAction(msg)
  // console.log("  √  ", target.id, action)

  let res = parseResponse(ret)

  if (!res.css || !res.content) {
    console.error("Empty Response", res)
    return
  }

  // First, update the stylesheet
  addCSS(res.css)

  // Patch the node
  const next: VNode = create(res.content)
  const old: VNode = create(target)
  patch(next, old)

  // console.log("NEXT", next)

  // Emit relevant events
  let newTarget = document.getElementById(target.id)
  // let event = new Event("content", {bubbles:true})
  // newTarget.dispatchEvent(event)
  //

  // load doesn't bubble
  if (newTarget) {
    listenLoad(newTarget)
  }
  else {
    console.warn("Target Missing: ", target.id)
  }
  // setCheckboxes(newTarget)

  // Remove loading and clear add timeout

  clearTimeout(timeout)
  target.classList.remove("hyp-loading")
}


function addCSS(src: HTMLStyleElement) {
  const rules: any = src.sheet.cssRules
  for (const rule of rules) {
    if (addedRulesIndex.has(rule.cssText) == false) {
      rootStyles.sheet.insertRule(rule.cssText);
      addedRulesIndex.add(rule.cssText);
    }
  }
}

// function setCheckboxes(target: HTMLElement) {
//   target.querySelectorAll("input[type=checkbox]").forEach(input => {
//     console.log(input.attributes)
//   })
// }

type Response = {
  content: HTMLElement
  css: HTMLStyleElement
}

function parseResponse(vw: string): Response {
  const parser = new DOMParser()
  const doc = parser.parseFromString(vw, 'text/html')
  const css = doc.querySelector("style") as HTMLStyleElement
  const content = doc.querySelector("div") as HTMLElement

  return {
    content: content,
    css: css
  }
}


function init() {
  rootStyles = document.querySelector('style')

  listenLoadDocument(async function(target: HTMLElement, action: string) {
    runAction(target, action)
  })

  listenLoad(document.body)

  listenClick(async function(target: HTMLElement, action: string) {
    // console.log("CLICK", target.id, action)
    runAction(target, action)
  })

  listenDblClick(async function(target: HTMLElement, action: string) {
    // console.log("DBLCLICK", target.id, action)
    runAction(target, action)
  })

  listenKeydown(async function(target: HTMLElement, action: string) {
    // console.log("KEYDOWN", target.id, action)
    runAction(target, action)
  })

  listenKeyup(async function(target: HTMLElement, action: string) {
    // console.log("KEYUP", target.id, action)
    runAction(target, action)
  })

  listenFormSubmit(async function(target: HTMLElement, action: string, form: FormData) {
    // console.log("FORM", target.id, action, form)
    runAction(target, action, form)
  })

  listenChange(async function(target: HTMLElement, action: string) {
    // console.log("CHANGE", target.id, action)
    runAction(target, action)
  })

  listenInput(async function(target: HTMLElement, action: string) {
    console.log("INPUT", target.id, action)
    runAction(target, action)
  })
}


document.addEventListener("DOMContentLoaded", init)


// Should we connect to the socket or not?
const sock = new SocketConnection()
sock.connect()






type VNode = {
  // One of three value types are used:
  // - The tag name of the element
  // - "text" if text node
  // - "comment" if comment node
  type: string

  // An object whose key/value pairs are the attribute
  // name and value, respectively
  attributes: [string: string]

  // Is set to `true` if a node is an `svg`, which tells
  // Omdomdom to treat it, and its children, as such
  isSVGContext: Boolean

  // The content of a "text" or "comment" node
  content: string

  // An array of virtual node children
  children: Array<VNode>

  // The real DOM node
  node: Node
}



// no it should take over the whole page...
function errorHTML(error: Error): string {

  // TODO: match on error.name and handle it differently
  let style = [
    ".hyp-error {background-color:#DB3524; color:white; padding: 10px}",
    ".hyp-details {padding: 10px}"
  ]
  let content = `<div class='hyp-error'>${error.name}</div>`
  let details = `<div class='hyp-details'>${error.message}</div>`

  return ["<style>" + style.join("\n") + "</style>", content, details].join("\n")
}
