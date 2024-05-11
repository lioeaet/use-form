import { createContext, useCallback, useContext, useRef } from 'react'
import { useReducerWithRef } from './useReducerWithRef'
import {
  ADVANCED_VALIDATOR,
  ARRAY_FIELD,
  getFieldsValidateOnChange,
  getFieldsValidateOnBlur,
  getFieldsValidateOnSubmit,
  joinValidators,
  VALIDATOR_OBJ,
} from './validate'
import { iterateDeep, getFieldFromInst, splitFieldOfArrayName } from './util'
import { getReducer, getInitState } from './reducer'
export { advanced, array } from './validate'

export function useForm({ initValues, validators: validatorsMap, submit }) {
  // [{ arrFieldName, type, args }]
  const replacementsDuringValidationRef = useRef([])

  // для ликвидации состояния гонки
  const lastValidateObjRef = useRef({})

  // для отмены валидации уже валидированных значений
  const lastValidatedValuesRef = useRef({})

  const arrayFields = useArrayFields(validatorsMap)
  const childFields = useChildFields(validatorsMap, arrayFields)

  const [state, dispatch, stateRef] = useReducerWithRef(
    getReducer(
      replacementsDuringValidationRef,
      lastValidatedValuesRef,
      lastValidateObjRef,
      arrayFields
    ),
    getInitState(initValues)
  )

  const actions = {
    change: useCallback((name, value) => {
      dispatch({
        type: 'change',
        name,
        value,
      })

      // валидируются
      // 1. Само поле name по default если validationEnabled
      // 2. Зависимые поля по default, если у них validationEnabled
      const fieldsValidateOnChange = getFieldsValidateOnChange(
        name,
        validatorsMap,
        childFields,
        stateRef,
        arrayFields
      )
      return execValidateObject(fieldsValidateOnChange)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    blur: useCallback((name) => {
      dispatch({
        type: 'enable validation',
        name,
      })

      const fieldsValidateOnChange = getFieldsValidateOnChange(
        name,
        validatorsMap,
        childFields,
        stateRef,
        arrayFields
      )

      const fieldsValidateOnValidate = getFieldsValidateOnBlur(
        name,
        validatorsMap,
        childFields,
        arrayFields,
        stateRef
      )

      return execValidateObject(
        joinValidators(fieldsValidateOnChange, fieldsValidateOnValidate)
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    validate: useCallback((name) => {
      // const validateField = getValidateField(name, validatorsMap)
      // validateField()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    submit: async (e) => {
      e.preventDefault()
      dispatch({
        type: 'submit start',
      })
      const errors = await execValidateObject(
        getFieldsValidateOnSubmit(validatorsMap, arrayFields, stateRef)
      )

      if (errors.some((err) => err)) {
        dispatch({
          type: 'submit failure',
        })
      }

      return submit(stateRef.current.values)
        .then((res) => {
          dispatch({
            type: 'submit success',
          })
        })
        .catch((e) => {
          dispatch({
            type: 'submit failure',
          })
        })
    },
    setLoader: useCallback((name, loader) => {
      dispatch({
        type: 'set loader',
        name,
        loader,
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    setError: useCallback((name, error) => {
      dispatch({
        type: 'set error',
        name,
        error,
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    reset: useCallback((initValues) => {
      dispatch({
        type: 'reset',
        initValues,
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    insert: useCallback((name, i, value) => {
      dispatch({
        type: 'array insert',
        name,
        i,
        value,
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    replace: useCallback((name, from, to) => {
      dispatch({
        type: 'array replace',
        name,
        from,
        to,
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    remove: useCallback((name, i) => {
      dispatch({
        type: 'array remove',
        name,
        i,
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  }

  function execValidateObject(validateObj) {
    const fieldsErrors = {}
    const fieldsPromises = {}

    // если во время валидации произошли изменения индексов в массивах
    // применяем их к fieldName внутри валидаций
    const replacementsDuringValidation = []
    replacementsDuringValidationRef.current.push(replacementsDuringValidation)
    function removeReplacementsDuringValidation() {
      const i = replacementsDuringValidationRef.current.indexOf(
        replacementsDuringValidation
      )
      replacementsDuringValidationRef.current.splice(i, 1)
    }

    // при первой ошибке, показываем её и ставим setLoading(false)
    // (остальные валидации после этого игнорируем)
    // при последней асинхронной валидации
    // если ошибки нет в ней и в fieldsErrors[fieldName]
    // ставим setLoading(false) и setError(null)
    // если нет асинхронных валидаций,
    // то setError(null) делаем на последней синхронной валидации
    // а setLoading трогаем

    outer: for (let fieldName in validateObj) {
      const { validators, argsFields } = validateObj[fieldName]
      const values = argsFields.map((field) =>
        getFieldFromInst(field, stateRef.current.values)
      )

      const shouldValidate =
        !lastValidatedValuesRef.current[fieldName] ||
        lastValidatedValuesRef.current[fieldName].some(
          (val, i) => val !== values[i]
        )
      if (!shouldValidate) {
        fieldsErrors[fieldName] = fieldsPromises[fieldName] =
          stateRef.current.errors[fieldName]
        continue
      }

      lastValidateObjRef.current[fieldName] = validateObj[fieldName]
      lastValidatedValuesRef.current[fieldName] = values

      // для поля один промис
      // выполняем его при первой ошибке, либо при завершении последней валидации
      let resolveValidationPromise
      let promisesCount = 0

      for (let i = 0; i < validators.length; i++) {
        const validator = validators[i]
        const result = validator(...values)

        if (result?.then) {
          if (!promisesCount) actions.setLoader(fieldName, true)
          promisesCount++
          if (!fieldsPromises[fieldName]) {
            // eslint-disable-next-line no-loop-func
            fieldsPromises[fieldName] = new Promise((r) => {
              resolveValidationPromise = r
            })
          }
          // eslint-disable-next-line no-loop-func
          result.then((error) => {
            const arrayOfFieldName = arrayFields.find((arrField) =>
              fieldName.startsWith(arrField)
            )
            let actualFieldName = fieldName
            if (arrayOfFieldName) {
              // меняем имя поля на актуальное
              // если во время валидации в родительском массиве перестановки
              actualFieldName = updNameWithArrayReplacements(
                arrayOfFieldName,
                fieldName,
                replacementsDuringValidation
              )
              if (!actualFieldName) return
            }

            if (fieldsErrors[actualFieldName]) return
            if (
              lastValidateObjRef.current[actualFieldName] !==
              validateObj[fieldName]
            )
              return

            --promisesCount

            if (error) {
              fieldsErrors[actualFieldName] = error
              actions.setError(actualFieldName, error)
              actions.setLoader(actualFieldName, false)
              removeReplacementsDuringValidation()
              resolveValidationPromise(error)
            } else if (!promisesCount) {
              actions.setError(actualFieldName, null)
              actions.setLoader(actualFieldName, false)
              removeReplacementsDuringValidation()
              resolveValidationPromise(null)
            }
          })
        } else {
          if (result) {
            fieldsErrors[fieldName] = result
            actions.setError(fieldName, result)
            if (promisesCount) {
              actions.setLoader(fieldName, false)
              removeReplacementsDuringValidation()
            }
            if (resolveValidationPromise) resolveValidationPromise(result)
            else fieldsPromises[fieldName] = result
            continue outer
          } else if (!promisesCount && i === validators.length - 1) {
            actions.setError(fieldName, null)
            if (resolveValidationPromise) resolveValidationPromise(null)
            else fieldsPromises[fieldName] = null
          }
        }
      }
    }
    const promisesArr = Object.values(fieldsPromises)
    return Promise.all(promisesArr)
  }

  const Form = useCallback(function Form({ children, ...restProps }) {
    return (
      <form {...restProps}>
        <FormContext.Provider
          value={{
            ...stateRef.current,
            actions,
          }}
        >
          {children}
        </FormContext.Provider>
      </form>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { Form, actions, state }
}

export const FormContext = createContext()

function updNameWithArrayReplacements(
  arrayOfFieldName,
  fieldName,
  replacementsDuringValidation
) {
  return replacementsDuringValidation.reduce((nextFieldName, arrayAction) => {
    if (!nextFieldName) return nextFieldName
    const { num, fieldEndPart } = splitFieldOfArrayName(
      arrayAction.name,
      nextFieldName
    )

    switch (arrayAction.type) {
      case 'array remove': {
        const { i } = arrayAction.args
        if (num === i) return null
        else if (num > i)
          return `${arrayAction.name}.${num - 1}.${fieldEndPart}`
        return nextFieldName
      }
      case 'array replace': {
        const { from, to } = arrayAction.args
        if (num === from) return `${arrayAction.name}.${to}.${fieldEndPart}`

        if (from < to) {
          // decrement полей от from + 1 до to
          // остальные поля без изменений
          if (num > from && num <= to) {
            return `${arrayAction.name}.${num - 1}.${fieldEndPart}`
          }
        } else {
          // increment полей от to до from - 1
          // остальные поля без изменений
          if (num >= to && num < from) {
            return `${arrayAction.name}.${num + 1}.${fieldEndPart}`
          }
        }
        return nextFieldName
      }
      case 'array insert': {
        const { i } = arrayAction.args
        if (num >= i) return `${arrayAction.name}.${num + 1}.${fieldEndPart}`
        return nextFieldName
      }
      default:
        return nextFieldName
    }
  }, fieldName)
}

function useArrayFields(validators) {
  const arrayFields = []

  iterateDeep(validators, (path, val) => {
    if (val?.[ARRAY_FIELD]) {
      const arrayFieldName = path
        .map((x) => (x === VALIDATOR_OBJ ? 'i' : x))
        .join('.')
      arrayFields.push(arrayFieldName)
    }
  })

  return arrayFields
}

function useChildFields(validators, arrayFields) {
  const childFields = {}

  iterateDeep(validators, (pathWithValidatorObjSymbol, val) => {
    if (val?.[ADVANCED_VALIDATOR]) {
      const realVal = val[VALIDATOR_OBJ]
      const realPath = pathWithValidatorObjSymbol.map((key) =>
        key === VALIDATOR_OBJ ? 'i' : key
      )

      realVal.PARENTS?.forEach?.((parentName) => {
        let childName = realPath.join('.')

        if (!childFields[parentName]) childFields[parentName] = [childName]
        else childFields.push(childName)
      })
    }
  })

  return childFields
}

export function useField(name) {
  const { values, errors, loaders, actions } = useContext(FormContext)

  return {
    value: getFieldFromInst(name, values),
    error: errors[name],
    loading: loaders[name],
    onChange: function onChange(value) {
      actions.change(name, value)
    },
    onBlur: function onBlur() {
      actions.blur(name)
    },
  }
}

export function useSubformsArray(name) {
  const { values, actions } = useContext(FormContext)
  return {
    value: getFieldFromInst(name, values),
    remove: (i) => actions.remove(name, i),
    replace: (from, to) => actions.replace(name, from, to),
    insert: (i, value) => actions.insert(name, i, value),
  }
}
