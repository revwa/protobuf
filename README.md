
# Revwa: Proto

This project is inspired by [proto-extract](https://github.com/adiwajshing/Baileys/tree/master/proto-extract), which itself is an inspiration from [whatsmeow](https://github.com/tulir/whatsmeow).

This is an iteration of the whole process of generating the Protobuf definitions. Both projects above are manually updated and depend on the maintainer to do this job. This means the Protobuf file, and its functions, may not represent the current state of the definition.

They are also not safely made and, although a minor detail, don't consider the default definitions.

## Reason

Parsing the internal specification from the obfuscated file is messy at best, but it's what we have to deal with since WhatsApp itself doesn't share them officially.

This is an attempt to do that in the best way possible, without manual updating it every so often.

## Technology

#### Context

WhatsApp uses [version 2 of Protocol Buffers](https://protobuf.dev/programming-guides/proto/). These aren't officially released but can be parsed away from the Web App JS.

#### Finding where they are

WhatsApp Web needs to know the Protobuf definition, so this means the specification must be somewhere that the browser can access.

Funnily enough, specification variables and declarations aren't that obfuscated. A list of messages names are initialized to `undefined (void 0)` and then assigned to their respective specification afterward:

`internalSpec`: Defines a message

`internalDefaults`: Defines the default values for properties of a message

We check for functions that have these assignments and store them as specification functions to parse later.

Cool! Now we need to glue those declarations together.

#### Getting the names

We need to have an internal Protobuf declaration that will be manipulated until the whole parse step is done. We do not need to respect every single Protobuf specification, only what we need to make this work, doing a [simple tree-like structure](https://github.com/revwa/proto/blob/main/src/types/protobuf.ts#L29).

In the specification functions, a list of names is initialized:

`message1, message1$message2, message3, ... = void 0`

These messages are the fully qualified names of the declarations they use! Although, a bit mangled...

`message1$message2` means that message `message1` has a nested message called `message2`. We demangle those by splitting on the dollar sign `($)` and adding those to the internal Protobuf tree. There's an interesting detail though: Mangled names that end with `Spec` are messages, otherwise, they are enums.

This is (probably?) a coincidence and will break if they add an enum with `Spec` at the end, but until then we rely on this aspect. This can be easily mitigated if necessary.

After parsing those, we add them to our Protobuf tree: For each path, create if necessary.

#### Associating local variables

After the initialization of names, the obfuscated file creates local variables for every name, and associates it with some name:

```js
const local = {}
specificationName = local
```

For each one of these, we store the variable name and its associated specification name.

The local variable can be an empty object or an enum definition. Empty objects are messages, otherwise, they are enums. We only care if they are defining an enum:

```js
const local = magicfunction({prop1: 1, prop2: 2})
specificationName = local
```

This is also the mitigation mentioned above: We don't need to rely on the name ending with `Spec` since we can know which ones are an enum by their later association. We currently do this for convenience.

#### The meat

After these steps, we have Protobuf names and their respective local variables. The next lines are defining the message properties:

```js
local1.internalSpec = {
    property1: [1, a.TYPES.UINT32],
    property2: [2, a.TYPES.MESSAGE, local2]
}
```

Nice! We can reference the `local1` to its previously assigned specification name.

The array is composed of:
- ID
- Type
- Message or Enum being referenced, if it exists

To each one of these that we encounter, we loop over their items and keep adding to our internal Protobuf tree. A little caveat is that the referenced property can be a local variable or a previously declared specification: `local2` or `message1$message2`

Defaults are also declared, although few:

```js
local1.internalDefaults = {
    property1: 1
}
```

`property1` is a property declared in `internalSpec` of `local1`, with its respective default value.

#### Wrapping things up

Thats it!

At this point, we have everything we need to create the complete Protobuf. The next step is formatting it correctly and writing it into a file. This doesn't need an explanation and is very straightforward.

We package it in the simplest way possible, in the release folder. Inside the CI, we move the Protobuf and its generated JS/TS bindings to it and pack it all up. 

To current knowledge, this is the extent that the Protobuf takes. If more details are declared elsewhere, it isn't considered; but can be if you share the information.