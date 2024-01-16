const AsyncFunction = async function () {}.constructor

/**
 * Hydrate element and all children
 * @param {HTMLElement} root Element to start hydrating from
 * @param {Record<string, any> | undefined} scope Scope to apply at root level
 * @param {boolean | undefined} reactive Enable/disable reactivity
 * @param {boolean | undefined} clean Remove binding attributes when finished
 */
export default async function hydrate(
    root,
    scope,
    reactive = true,
    clean = true
) {
    let initializing = reactive
    let currentEffect
    let iteration = 0
    let currentRoot

    const mutations = new Set()
    const effects = new Map()
    const runEffects = async () => {
        if (!reactive || !mutations.size) return
        for (const change of mutations) {
            for (const effect of effects.get(change)) await effect()
        }
        mutations.clear()
    }

    const createProxy = prefix => ({
        get(target, property) {
            if (!reactive) return target[property]
            if (
                typeof target[property] === 'object' &&
                !Array.isArray(target[property])
            )
                return new Proxy(
                    target[property],
                    createProxy(prefix + property + '.')
                )
            if (initializing && currentEffect) {
                const fullProperty = prefix + property
                if (!effects.has(fullProperty)) effects.set(fullProperty, [])
                effects.get(fullProperty).push(currentEffect)
            }
            return target[property]
        },
        set(target, property, value) {
            target[property] = value
            if (reactive) mutations.add(prefix + property)
            return true
        }
    })

    async function walk(element, scope, proxy) {
        if (element.attributes['x-ignore'])
            return element.removeAttribute('x-ignore')

        const remove = []
        if (element.attributes['x-data']) {
            currentRoot = element
            const newScope = await new AsyncFunction(
                '$root',
                '$el',
                `return (${element.attributes['x-data'].value})`
            ).apply(proxy ?? scope, [currentRoot, element])
            scope = {
                ...scope,
                ...newScope
            }
            proxy = new Proxy(scope, createProxy(iteration++ + '.'))
            element.$update = handler => {
                handler(proxy)
                return runEffects()
            }
            if (clean) remove.push('x-data')
        } else if (element.attributes['x-map']) {
            const parent = element.parentElement
            element.remove()
            const value = element.attributes['x-map'].value
            element.removeAttribute('x-map')
            const template = element.cloneNode(true)
            await hydrate(template, {})

            const computation = new AsyncFunction(
                '$root',
                '$el',
                `return (${value})`
            )
            const runComputation = () =>
                computation.apply(proxy, [currentRoot, element])

            currentEffect = async () => {
                const start = performance.now()
                parent.textContent = ''
                const records = await runComputation()
                for (const recordScope of records) {
                    await template.$update(scope => Object.assign(scope, recordScope))
                    parent.appendChild(template.cloneNode(true))
                }
                console.log(records.length, performance.now() - start)
            }

            currentEffect()
            currentEffect = undefined
            return
        } else if (scope && !proxy) {
            currentRoot = element
            proxy = new Proxy(scope, createProxy(iteration++ + '.'))
            element.$update = handler => {
                handler(proxy)
                return runEffects()
            }
        }
        if (proxy) {
            for (const { name, value } of element.attributes) {
                if (!value) continue

                if (name[0] === '@') {
                    const effect = new AsyncFunction(
                        '$event',
                        '$root',
                        '$el',
                        value
                    )
                    element.addEventListener(name.slice(1), e => {
                        requestAnimationFrame(async () => {
                            await effect.apply(proxy, [e, currentRoot, element])
                            runEffects()
                        })
                    })
                    if (clean) remove.push(name)
                    continue
                }

                if (name[0] === 'x' && name[1] === '-') {
                    const directive = name.slice(2)
                    if (directive === 'cloak') continue
                    if (clean) remove.push(name)

                    const computation = new AsyncFunction(
                        '$root',
                        '$el',
                        `return (${value})`
                    )
                    const runComputation = () =>
                        computation.apply(proxy, [currentRoot, element])

                    if (directive === 'effect') {
                        // Effect binding
                        currentEffect = async () => {
                            await runComputation()
                            requestAnimationFrame(() => {
                                runEffects()
                            })
                        }
                    } else if (directive === 'class') {
                        // Special class binding
                        currentEffect = async () => {
                            const value = await runComputation(computation)
                            if (typeof value !== 'object') return
                            Object.entries(value).forEach(
                                ([classList, enabled]) => {
                                    classList
                                        .split(' ')
                                        .filter(piece => piece)
                                        .forEach(className => {
                                            if (enabled)
                                                element.classList.add(className)
                                            else
                                                element.classList.remove(
                                                    className
                                                )
                                        })
                                }
                            )
                        }
                    } else {
                        // Generic binding
                        let property = directive
                        if (directive === 'text') property = 'innerText'
                        else if (directive === 'html') property = 'innerHTML'

                        currentEffect = async () => {
                            const value = await runComputation()
                            if (
                                value === undefined ||
                                element[property] === value
                            )
                                return
                            element[property] = value
                        }
                    }

                    currentEffect()
                    currentEffect = undefined
                }
            }
        }

        for (const child of element.children) await walk(child, scope, proxy)

        if (
            element.attributes['x-init'] &&
            element.attributes['x-init'].value &&
            proxy
        ) {
            await new AsyncFunction(
                '$root',
                '$el',
                element.attributes['x-init'].value
            ).apply(proxy, [currentRoot, element])
            requestAnimationFrame(() => {
                runEffects()
            })
            if (clean) remove.push('x-init')
        }

        if (element.attributes['x-cloak']) element.removeAttribute('x-cloak')
        remove.forEach(name => element.removeAttribute(name))
    }

    await walk(root, scope)
    initializing = false
}
